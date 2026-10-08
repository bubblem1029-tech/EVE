/**
 * SSO Cookie 类型定义（仅类型，不做登录/缓存）
 *
 * SSO 登录态的唯一缓存与登录入口都在 eve-backend
 * （src/services/ai/sso-cookies.ts，Redis key sso:{username}）。
 * suite 侧只负责接收服务端下发的 cookie 并注入浏览器，不再持有任何
 * Redis/进程内缓存，避免多套缓存各自过期、互相覆盖造成「坏登录态被复用」。
 */

export interface SsoCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}
