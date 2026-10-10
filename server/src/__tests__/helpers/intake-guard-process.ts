// OFFLINE process fixture. IPC only: no credential in argv, logs or state files.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.once('message', async (input: any) => {
  try {
    if (input.role === 'server') {
      process.env.PAPERCLIP_INTAKE_GUARD_IDENTITY = JSON.stringify(input.identity);
      const { createDb } = await import('@paperclipai/db');
      const { createApp } = await import('../../app.js');
      const { createStorageService } = await import('../../storage/service.js');
      const { createLocalDiskStorageProvider } = await import('../../storage/local-disk-provider.js');
      const app = await createApp(createDb(input.connectionString), {
        uiMode: 'none', serverPort: 0, deploymentMode: 'authenticated', deploymentExposure: 'private',
        allowedHostnames: ['127.0.0.1'], bindHost: '127.0.0.1', authReady: true,
        companyDeletionEnabled: false, localPluginDir: join(input.root, 'plugins'), managedPluginAutoInstall: [],
        storageService: createStorageService(createLocalDiskStorageProvider(join(input.root, 'storage'))),
        decisionServiceOptions: { wakeOriginAgent: async () => undefined }, resolveSession: async () => null,
      });
      const server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        process.send?.({ ready: true, pid: process.pid, port: typeof address === 'object' ? address?.port : null });
      });
      return;
    }
    // Contract sampler fixture, NOT Mista PR #201's unadapted production sampler.
    const headers = { Authorization: 'Bearer ' + input.token, 'Content-Type': 'application/json' };
    let state: { episodeId: string; findingId?: string };
    try { state = JSON.parse(await readFile(input.statePath, 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; state = { episodeId: randomUUID() }; }
    const listPath = input.base + '/api/companies/' + input.companyId + '/intake-guard/findings';
    if (input.action === 'read') {
      const response = await fetch(input.base + '/api/intake-guard/findings/' + state.findingId, { headers });
      const body = await response.json();
      if (response.status === 200 && body.id !== state.findingId) throw new Error('receipt mismatch');
      process.send?.({ status: response.status, id: body.id, pid: process.pid });
    } else {
      await writeFile(input.statePath, JSON.stringify(state), { mode: 0o600 });
      const response = await fetch(listPath, { method: 'POST', headers, body: JSON.stringify({
        type: 'intake_stall', episodeId: state.episodeId, reasons: ['queue_growing_without_completion'],
        observedAt: new Date().toISOString(), queued: 5, lastCompletedAt: null, producerSuspended: true,
      }) });
      const body = await response.json();
      if (response.status === 201) {
        state.findingId = body.id;
        await writeFile(input.statePath, JSON.stringify(state), { mode: 0o600 });
      }
      process.send?.({ status: response.status, id: body.id, pid: process.pid });
    }
    process.exit(0);
  } catch { process.send?.({ failed: true }); process.exit(1); }
});
