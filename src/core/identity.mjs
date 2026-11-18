// 本机可信身份标识（纯本地，无账号服务/网络依赖）。
// 个人独立版仅使用本机 Mock 身份；accountIdentity 保留为受控的本机身份工厂，
// isAccountIdentity 供各存储层做身份断言（与 provider==='mock' 分支并列）。

const fail = code => Object.assign(new Error(code), { code });
const trusted = new WeakSet();

/** Build a frozen, trusted local identity from a validated account-like descriptor. */
export function accountIdentity(account) {
  if (!account || !/^[a-zA-Z0-9_-]{1,64}$/.test(account.id) || typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.length > 80 || account.tier !== 'personal') throw fail('ACCOUNT_INVALID');
  const identity = Object.freeze({ companyId: `personal-${account.id}`, userId: `user-${account.id}`, displayName: account.displayName, provider: 'account' });
  trusted.add(identity);
  return identity;
}

/** True only for identities minted by this module (trusted, not user-supplied). */
export const isAccountIdentity = identity => trusted.has(identity);
