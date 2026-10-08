import { SITE_FILING } from '@/lib/site-filing'

/** 页面底部备案号：小号灰字，移动端自动换行居中。 */
export default function SiteFiling({ className = '' }: { className?: string }) {
  const { icp, police } = SITE_FILING
  return (
    <footer
      className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 text-[11px] leading-5 text-muted-foreground/70 ${className}`}
    >
      <a
        href={icp.url}
        target="_blank"
        rel="noreferrer"
        className="hover:text-foreground transition-colors"
      >
        {icp.text}
      </a>
      <a
        href={police.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <img src={police.icon} alt="" aria-hidden="true" className="h-3.5 w-auto" />
        {police.text}
      </a>
    </footer>
  )
}
