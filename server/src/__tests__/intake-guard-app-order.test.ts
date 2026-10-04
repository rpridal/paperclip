import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('mounts terminal intake admission before every alternative auth and side-effect route (source topology, not createApp execution)', () => {
  const source = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
  const admission = source.indexOf('app.use(intakeGuardMiddleware(db));');
  expect(admission).toBeGreaterThan(0);
  for (const registration of ['app.use(cloudRuntimeIdentityMiddleware(db))', 'app.use(runtimeConnectionIntentRoutes(db))', 'actorMiddleware(db,', 'app.use(chatWebhookRoutes(chatChannels))']) {
    expect(source.indexOf(registration)).toBeGreaterThan(admission);
  }
  // Logger must observe parser failures, including malformed intake requests.
  expect(source.indexOf('app.use(httpLogger);')).toBeLessThan(source.indexOf('app.use(\n    COMPANY_IMPORT_API_PATH,'));
});
