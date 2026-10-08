/**
 * 网站备案信息（集中维护，改备案号只改这里）。
 * - ICP 备案：工信部要求页面底部展示并链接到 beian.miit.gov.cn
 * - 公安联网备案：展示备案号并链接到全国互联网安全管理服务平台
 */
export const SITE_FILING = {
  icp: {
    text: '苏ICP备2026067420号-3',
    url: 'https://beian.miit.gov.cn/',
  },
  police: {
    text: '苏公网安备32028102004180号',
    code: '32028102004180',
    url: 'https://beian.mps.gov.cn/#/query/webSearch?code=32028102004180',
    /** 公安备案图标，取自 beian.mps.gov.cn 官方页面，本地托管在 public/ 下 */
    icon: '/beian-gongan.png',
  },
} as const
