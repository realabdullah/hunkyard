import type { ModelTarget } from './index';
import { hostedProviderOrigins, isHostedProvider } from './providers';

export const validateTarget = (target: ModelTarget): URL => {
  const url = new URL(target.endpoint);
  if (target.privacy === 'local-only' && /(?:^|[:_-])cloud(?:$|[:_-])/i.test(target.model))
    throw new Error('Cloud-backed model names are forbidden in local-only mode.');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error('Unsafe model endpoint.');
  if (!isHostedProvider(target.provider)) {
    if (
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['/', '/v1', '/v1/'].includes(url.pathname)
    )
      throw new Error(
        'Local runtimes require a literal loopback origin; DNS names and remote endpoints are forbidden.',
      );
  } else {
    if (target.privacy === 'local-only')
      throw new Error('Local-only mode forbids hosted inference.');
    if (!target.cloudConsent)
      throw new Error('Explicit cloud consent is required for this repository.');
    if (
      !hostedProviderOrigins[target.provider]?.includes(url.origin) ||
      !(
        target.provider === 'openai' || target.provider === 'deepseek'
          ? ['/']
          : ['/', '/v1', '/v1/']
      ).includes(url.pathname)
    )
      throw new Error('Only the named provider HTTPS origins are allowed.');
    const approved =
      target.approvedHostedOrigins ??
      (target.provider === 'openai' ? ['https://api.openai.com'] : []);
    if (!approved.includes(url.origin))
      throw new Error('Explicit consent for this hosted destination is required.');
  }
  return url;
};

export const assertCurrentAuthorization = (target: ModelTarget, current: ModelTarget) => {
  if (!isHostedProvider(target.provider)) return;
  if (current.privacy === 'local-only' || !current.cloudConsent)
    throw new Error('Repository cloud access was revoked.');
  const approved = current.approvedHostedOrigins ?? ['https://api.openai.com'];
  if (!approved.includes(new URL(target.endpoint).origin))
    throw new Error('Repository consent for this hosted destination was revoked.');
};
