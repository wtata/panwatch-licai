"""实盘持仓买卖流水：加权成本、全平、资金不足、手续费。"""

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.platform.persistence.database import Base
from src.platform.persistence.models import Account, PortfolioTrade, Position, Stock  # noqa: F401


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    return session, engine


def _book(session, *, funds=10000.0, market="CN", symbol="600519", name="贵州茅台", qty=None, cost=None, invested=None):
    account = Account(name="招商证券", available_funds=funds)
    stock = Stock(symbol=symbol, name=name, market=market)
    session.add_all([account, stock])
    session.flush()
    position = None
    if qty is not None:
        position = Position(
            account_id=account.id,
            stock_id=stock.id,
            cost_price=cost if cost is not None else 0,
            quantity=qty,
            invested_amount=invested,
        )
        session.add(position)
    session.commit()
    session.refresh(account)
    session.refresh(stock)
    if position is not None:
        session.refresh(position)
    return account, stock, position


def _buy(session, account, stock, quantity, price, fee=0, position=None):
    from src.modules.portfolio.position_ledger import TradeRequest, execute_trade

    return execute_trade(
        session,
        TradeRequest(
            side="buy",
            account_id=account.id,
            stock_id=stock.id,
            position_id=position.id if position is not None else None,
            quantity=quantity,
            price=price,
            fee=fee,
        ),
    )


def _sell(session, account, stock, position, quantity, price, fee=0):
    from src.modules.portfolio.position_ledger import TradeRequest, execute_trade

    return execute_trade(
        session,
        TradeRequest(
            side="sell",
            account_id=account.id,
            stock_id=stock.id,
            position_id=position.id,
            quantity=quantity,
            price=price,
            fee=fee,
        ),
    )


def test_buy_includes_fee_in_weighted_cost_and_cash():
    """买入把手续费计入总成本，并从可用资金扣除。"""
    session, engine = _session()
    account, stock, _ = _book(session, funds=10000)
    result = _buy(session, account, stock, 100, 10, fee=5)
    position = result["position"]

    assert position.quantity == 100
    assert position.invested_amount == 1005
    assert position.cost_price == 10.05
    assert result["account"].available_funds == 8995
    trade = result["trade"]
    assert trade.side == "buy"
    assert trade.amount == 1000
    assert trade.fee == 5
    assert trade.cash_delta == -1005
    assert trade.position_quantity_before == 0
    assert trade.position_quantity_after == 100
    assert trade.available_funds_before == 10000
    assert trade.available_funds_after == 8995
    session.close()
    engine.dispose()


def test_add_on_buy_recalculates_weighted_average():
    """加仓按总成本加权，已有持仓没填投入资金时用成本价×数量。"""
    session, engine = _session()
    account, stock, position = _book(session, funds=5000, qty=100, cost=10, invested=None)
    result = _buy(session, account, stock, 100, 12, position=position)
    position = result["position"]

    assert position.quantity == 200
    assert position.invested_amount == 2200
    assert position.cost_price == 11
    assert result["account"].available_funds == 3800
    assert result["trade"].position_quantity_before == 100
    assert result["trade"].position_quantity_after == 200
    session.close()
    engine.dispose()


def test_partial_sell_keeps_average_cost_and_nets_fee():
    """部分卖出等比例减少总成本，手续费只减少回笼现金。"""
    session, engine = _session()
    account, stock, _ = _book(session, funds=10000)
    _buy(session, account, stock, 100, 10, fee=5)
    session.refresh(account)
    position = session.query(Position).one()
    added = _buy(session, account, stock, 100, 20, position=position)
    position = added["position"]
    sold = _sell(session, account, stock, position, 100, 18, fee=10)
    position = sold["position"]

    assert position.quantity == 100
    assert position.invested_amount == 1502.5
    assert position.cost_price == 15.025
    assert sold["account"].available_funds == 8785
    assert sold["closed"] is False
    assert sold["trade"].amount == 1800
    assert sold["trade"].cash_delta == 1790
    assert sold["trade"].position_quantity_before == 200
    assert sold["trade"].position_quantity_after == 100
    session.close()
    engine.dispose()


def test_sell_all_removes_position_and_returns_cash():
    """卖光删除持仓行，成交额扣除手续费后回到可用资金。"""
    session, engine = _session()
    account, stock, position = _book(session, funds=1000, qty=100, cost=10, invested=1000)
    result = _sell(session, account, stock, position, 100, 16, fee=1)

    assert result["closed"] is True
    assert result["position"] is None
    assert session.query(Position).count() == 0
    assert result["account"].available_funds == 2599
    trade = result["trade"]
    assert trade.position_quantity_after == 0
    assert trade.cash_delta == 1599
    assert trade.invested_amount_after is None
    session.close()
    engine.dispose()


def test_insufficient_funds_rejects_without_changing_books():
    """资金不足时明确失败，持仓和现金都保持原样。"""
    from fastapi import HTTPException

    from src.modules.portfolio.api.accounts import TradeCreate, create_portfolio_trade

    session, engine = _session()
    account, stock, position = _book(session, funds=100, qty=10, cost=8, invested=80)
    try:
        create_portfolio_trade(
            TradeCreate(
                side="buy",
                account_id=account.id,
                stock_id=stock.id,
                position_id=position.id,
                quantity=100,
                price=10,
                fee=0,
            ),
            session,
        )
        raise AssertionError("应当拒绝资金不足的买入")
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "可用资金不足" in str(exc.detail)
        assert "1000.00" in str(exc.detail)
        assert "100.00" in str(exc.detail)

    session.expire_all()
    assert session.get(Account, account.id).available_funds == 100
    held = session.get(Position, position.id)
    assert held.quantity == 10
    assert held.cost_price == 8
    assert session.query(PortfolioTrade).count() == 0
    session.close()
    engine.dispose()


def test_sell_rejects_over_quantity_and_fee_above_proceeds():
    """卖出不能超过持仓，手续费也不能超过成交额。"""
    from src.modules.portfolio.position_ledger import TradeError, TradeRequest, execute_trade

    session, engine = _session()
    account, stock, position = _book(session, funds=0, qty=100, cost=10, invested=1000)
    try:
        execute_trade(
            session,
            TradeRequest(
                side="sell",
                account_id=account.id,
                stock_id=stock.id,
                position_id=position.id,
                quantity=101,
                price=10,
            ),
        )
        raise AssertionError("超卖应当失败")
    except TradeError as exc:
        assert "超过持仓" in exc.message

    try:
        execute_trade(
            session,
            TradeRequest(
                side="sell",
                account_id=account.id,
                stock_id=stock.id,
                position_id=position.id,
                quantity=10,
                price=1,
                fee=11,
            ),
        )
        raise AssertionError("手续费超过成交额应当失败")
    except TradeError as exc:
        assert "手续费不能超过成交额" in exc.message

    session.expire_all()
    assert session.get(Position, position.id).quantity == 100
    assert session.get(Account, account.id).available_funds == 0
    assert session.query(PortfolioTrade).count() == 0
    session.close()
    engine.dispose()


def test_hk_buy_converts_cash_but_keeps_local_cost(monkeypatch):
    """港股成本仍用港币，可用资金按汇率扣人民币。"""
    monkeypatch.setattr(
        "src.modules.portfolio.position_ledger._default_fx",
        lambda market: 0.9 if market == "HK" else 1,
    )
    from src.modules.portfolio.api.accounts import TradeCreate, create_portfolio_trade

    session, engine = _session()
    account, stock, _ = _book(session, funds=5000, market="HK", symbol="00700", name="腾讯控股")
    result = create_portfolio_trade(
        TradeCreate(side="buy", account_id=account.id, stock_id=stock.id, quantity=100, price=10, fee=0),
        session,
    )

    assert result["position"]["cost_price"] == 10
    assert result["position"]["invested_amount"] == 1000
    assert result["account"]["available_funds"] == 4100
    assert result["trade"]["fx_rate"] == 0.9
    assert result["trade"]["cash_delta"] == -900
    assert result["trade"]["amount"] == 1000
    session.close()
    engine.dispose()


def test_delete_position_keeps_cash_unless_settle_checked(monkeypatch):
    """删除默认不回笼；勾选按现价回笼才记卖出并加现金。"""
    from src.modules.portfolio.api.accounts import delete_position

    monkeypatch.setattr(
        "src.modules.portfolio.api.accounts._fetch_quotes_for_stocks",
        lambda stocks: {stocks[0].symbol: {"current_price": 12}},
    )
    session, engine = _session()
    account, _stock, position = _book(session, funds=1000, qty=100, cost=10, invested=1000)
    plain = delete_position(position.id, session, False)
    assert plain == {"success": True}
    session.expire_all()
    assert session.get(Account, account.id).available_funds == 1000
    assert session.query(PortfolioTrade).count() == 0

    _account, _stock, position = _book(session, funds=1000, qty=100, cost=10, invested=1000)
    settled = delete_position(position.id, session, True)
    assert settled["settled"] is True
    assert settled["cash_delta"] == 1200
    session.expire_all()
    assert session.get(Position, position.id) is None
    assert session.get(Account, _account.id).available_funds == 2200
    trade = session.query(PortfolioTrade).one()
    assert trade.side == "sell"
    assert "按现价回笼" in (trade.note or "")
    session.close()
    engine.dispose()


def test_manual_position_create_does_not_move_cash_or_write_trades():
    """手工录入/OCR 导入仍只写持仓，不扣现金、不记流水。"""
    from src.modules.portfolio.api.accounts import PositionCreate, create_position

    session, engine = _session()
    account, stock, _ = _book(session, funds=8000)
    create_position(
        PositionCreate(account_id=account.id, stock_id=stock.id, cost_price=20, quantity=50),
        session,
    )
    session.expire_all()
    assert session.get(Account, account.id).available_funds == 8000
    assert session.query(PortfolioTrade).count() == 0
    assert session.query(Position).one().quantity == 50
    session.close()
    engine.dispose()


def test_summary_uses_updated_cost_and_available_funds(monkeypatch):
    """汇总里的总成本、可用资金与买卖后的账本一致。"""
    monkeypatch.setattr("src.modules.portfolio.api.accounts.get_hkd_cny_rate", lambda: 0.92)
    monkeypatch.setattr("src.modules.portfolio.api.accounts.get_usd_cny_rate", lambda: 7.2)
    from src.modules.portfolio.api.accounts import get_portfolio_summary, list_portfolio_trades

    session, engine = _session()
    account, stock, _ = _book(session, funds=10000)
    _buy(session, account, stock, 100, 10, fee=5)
    summary = get_portfolio_summary(None, False, session)

    assert summary["total"]["available_funds"] == 8995
    assert summary["total"]["total_cost"] == 1005
    assert summary["accounts"][0]["available_funds"] == 8995
    assert summary["accounts"][0]["positions"][0]["quantity"] == 100
    assert summary["accounts"][0]["positions"][0]["cost_price"] == 10.05
    assert summary["accounts"][0]["positions"][0]["invested_amount"] == 1005

    rows = list_portfolio_trades(db=session)
    assert len(rows) == 1
    assert rows[0]["side"] == "buy"
    assert rows[0]["cash_delta"] == -1005
    assert rows[0]["position_quantity_before"] == 0
    assert rows[0]["position_quantity_after"] == 100
    session.close()
    engine.dispose()


def test_portfolio_trades_migration_creates_table():
    """迁移会建出实盘流水表。"""
    from src.platform.persistence.migrations import _m129_portfolio_trades

    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE accounts (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE stocks (id INTEGER PRIMARY KEY)"))
        _m129_portfolio_trades(conn)
        row = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_trades'")
        ).first()
        assert row is not None
        columns = {item[1] for item in conn.execute(text("PRAGMA table_info(portfolio_trades)")).fetchall()}
    assert "cash_delta" in columns
    assert "invested_amount_after" in columns
    engine.dispose()
