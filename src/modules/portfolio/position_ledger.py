"""实盘持仓买卖账本。

规则（与模拟盘无关）：
- 成本价、投入资金（总成本）使用标的交易币种。
- 账户 available_funds 是人民币。现金变动 =（成交额 ± 手续费）× 汇率。
  A 股汇率为 1；港股/美股沿用持仓汇总里的汇率。
- 买入：成交额 + 手续费计入总成本，加权平均成本 = 总成本 / 数量。
  可用资金不足则整笔拒绝，不允许透支。
- 卖出：成交额 - 手续费回笼到可用资金。剩余仓位按原加权成本等比例保留总成本。
  卖光则删除持仓行。卖出手续费只减少回笼现金，不抬高剩余成本。
- 手工删除持仓默认不走本账本，因此不改现金。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func
from sqlalchemy.orm import Session

from src.platform.persistence.models import Account, PortfolioTrade, Position, Stock

_CENT = Decimal("0.01")


class TradeError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class TradeRequest:
    side: str
    account_id: int | None = None
    stock_id: int | None = None
    position_id: int | None = None
    quantity: int = 0
    price: float = 0
    fee: float = 0
    note: str = ""
    fx_rate: float | None = None


def _d(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None:
        return Decimal("0")
    return Decimal(str(value))


def _money(value: Decimal) -> Decimal:
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _f(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value)


def _default_fx(market: str) -> float:
    if market == "HK":
        from src.modules.portfolio.api.accounts import get_hkd_cny_rate

        return float(get_hkd_cny_rate())
    if market == "US":
        from src.modules.portfolio.api.accounts import get_usd_cny_rate

        return float(get_usd_cny_rate())
    return 1.0


def _opening_basis(position: Position) -> Decimal:
    """已有总成本优先；历史持仓没填投入资金时，用成本价 × 数量。"""
    if position.invested_amount is not None:
        return _money(_d(position.invested_amount))
    return _money(_d(position.cost_price) * Decimal(int(position.quantity)))


def _resolve(db: Session, req: TradeRequest) -> tuple[Account, Stock, Position | None]:
    side = (req.side or "").strip().lower()
    if side not in ("buy", "sell"):
        raise TradeError("方向只能是买入或卖出")
    if int(req.quantity or 0) <= 0:
        raise TradeError("数量必须大于 0，按股填写")
    if _d(req.price) <= 0:
        raise TradeError("成交价必须大于 0")
    if _d(req.fee) < 0:
        raise TradeError("手续费不能为负")

    position: Position | None = None
    if req.position_id:
        position = db.query(Position).filter(Position.id == req.position_id).first()
        if not position:
            raise TradeError("持仓不存在", 404)
        if req.account_id and int(req.account_id) != int(position.account_id):
            raise TradeError("持仓与账户不匹配")
        if req.stock_id and int(req.stock_id) != int(position.stock_id):
            raise TradeError("持仓与股票不匹配")
        account = position.account
        stock = position.stock
        if account is None or stock is None:
            raise TradeError("持仓缺少账户或股票")
    else:
        if not req.account_id or not req.stock_id:
            raise TradeError("请指定账户和股票")
        account = db.query(Account).filter(Account.id == req.account_id).first()
        if not account:
            raise TradeError("账户不存在", 404)
        stock = db.query(Stock).filter(Stock.id == req.stock_id).first()
        if not stock:
            raise TradeError("股票不存在", 404)
        position = (
            db.query(Position)
            .filter(
                Position.account_id == account.id,
                Position.stock_id == stock.id,
            )
            .first()
        )

    if side == "sell" and position is None:
        raise TradeError("该账户还没有这笔持仓，无法卖出")
    return account, stock, position


def execute_trade(db: Session, req: TradeRequest) -> dict:
    """记一笔买卖，并更新持仓与可用资金。失败时不改账。"""
    account, stock, position = _resolve(db, req)
    side = req.side.strip().lower()
    quantity = int(req.quantity)
    price = _d(req.price)
    fee = _money(_d(req.fee))
    gross = _money(price * Decimal(quantity))
    fx = _d(req.fx_rate) if req.fx_rate is not None else _d(_default_fx(stock.market or "CN"))
    if fx <= 0:
        raise TradeError("汇率无效")

    funds_before = _money(_d(account.available_funds))
    qty_before = int(position.quantity) if position else 0
    cost_before = _d(position.cost_price) if position else None
    invested_before = _opening_basis(position) if position else Decimal("0")

    if side == "buy":
        local_cost = _money(gross + fee)
        cash_out = _money(local_cost * fx)
        if funds_before < cash_out:
            raise TradeError(
                f"可用资金不足：需要 {cash_out:.2f} 元，当前可用 {funds_before:.2f} 元"
            )
        funds_after = _money(funds_before - cash_out)
        cash_delta = -cash_out
        invested_after = _money(invested_before + local_cost)
        qty_after = qty_before + quantity
        cost_after = invested_after / Decimal(qty_after)
    else:
        if quantity > qty_before:
            raise TradeError(f"卖出数量超过持仓（当前 {qty_before} 股）")
        if fee > gross:
            raise TradeError("手续费不能超过成交额")
        local_net = _money(gross - fee)
        cash_in = _money(local_net * fx)
        funds_after = _money(funds_before + cash_in)
        cash_delta = cash_in
        if quantity == qty_before:
            sold_basis = invested_before
        else:
            sold_basis = _money(invested_before * Decimal(quantity) / Decimal(qty_before))
        invested_after = _money(invested_before - sold_basis)
        qty_after = qty_before - quantity
        cost_after = (invested_after / Decimal(qty_after)) if qty_after else None

    account.available_funds = _f(funds_after)
    closed = side == "sell" and qty_after == 0
    if side == "buy" and position is None:
        max_order = (
            db.query(func.max(Position.sort_order))
            .filter(Position.account_id == account.id)
            .scalar()
            or 0
        )
        position = Position(
            account_id=account.id,
            stock_id=stock.id,
            cost_price=_f(cost_after),
            quantity=qty_after,
            invested_amount=_f(invested_after),
            sort_order=int(max_order) + 1,
        )
        db.add(position)
        db.flush()
    elif closed:
        db.delete(position)
        position = None
    else:
        position.quantity = qty_after
        position.invested_amount = _f(invested_after)
        position.cost_price = _f(cost_after)

    note = (req.note or "").strip()[:200]
    trade = PortfolioTrade(
        account_id=account.id,
        stock_id=stock.id,
        account_name=account.name or "",
        stock_symbol=stock.symbol or "",
        stock_name=stock.name or "",
        stock_market=stock.market or "",
        side=side,
        quantity=quantity,
        price=_f(price),
        fee=_f(fee),
        amount=_f(gross),
        cash_delta=_f(cash_delta),
        fx_rate=_f(fx),
        position_quantity_before=qty_before,
        position_quantity_after=qty_after,
        cost_price_before=_f(cost_before) if cost_before is not None else None,
        cost_price_after=_f(cost_after) if cost_after is not None else None,
        invested_amount_before=_f(invested_before) if qty_before else None,
        invested_amount_after=_f(invested_after) if qty_after else None,
        available_funds_before=_f(funds_before),
        available_funds_after=_f(funds_after),
        note=note,
        traded_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(trade)
    db.commit()
    db.refresh(trade)
    if position is not None:
        db.refresh(position)
    db.refresh(account)
    return {
        "trade": trade,
        "account": account,
        "position": position,
        "stock": stock,
        "closed": closed,
    }
