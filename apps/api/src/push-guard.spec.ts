import { assertEffectiveDatabase, classifyPushEndpoint, publishedDatabaseName, pushEndpointShapeAllowed } from '@eveops/operations';

const probe = {
  $queryRaw: async () => [{ name: 'eveops_regression' }],
};

describe('database name publication', () => {
  const previous = process.env.EVEOPS_REQUIRE_DATABASE;

  afterAll(() => {
    if (previous === undefined) delete process.env.EVEOPS_REQUIRE_DATABASE;
    else process.env.EVEOPS_REQUIRE_DATABASE = previous;
  });

  it('omits the name until the startup guard matches', async () => {
    delete process.env.EVEOPS_REQUIRE_DATABASE;
    await assertEffectiveDatabase(probe as never);
    expect(publishedDatabaseName()).toBeUndefined();

    process.env.EVEOPS_REQUIRE_DATABASE = 'eveops';
    expect(publishedDatabaseName()).toBeUndefined();

    process.env.EVEOPS_REQUIRE_DATABASE = 'eveops_regression';
    expect(publishedDatabaseName()).toBe('eveops_regression');
  });

  it('does not accept a mismatched database', async () => {
    process.env.EVEOPS_REQUIRE_DATABASE = 'eveops';
    await expect(assertEffectiveDatabase(probe as never)).rejects.toThrow(/eveops_regression/);
    expect(publishedDatabaseName()).toBeUndefined();
  });
});

describe('push endpoint classification', () => {
  it('refuses credentials, raw addresses, and local names', () => {
    expect(pushEndpointShapeAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointShapeAllowed('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(pushEndpointShapeAllowed('https://user:pass@fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(pushEndpointShapeAllowed('https://127.0.0.1/push')).toBe(false);
    expect(pushEndpointShapeAllowed('https://metadata.google.internal/')).toBe(false);
    expect(pushEndpointShapeAllowed('https://localhost/push')).toBe(false);
    expect(pushEndpointShapeAllowed('not a url')).toBe(false);
  });

  it('refuses a public name that resolves to a private address and retries lookup failure', async () => {
    await expect(classifyPushEndpoint('https://push.example.test/device', async () => [{ address: '10.1.2.3', family: 4 }])).resolves.toBe('refuse');
    await expect(classifyPushEndpoint('https://push.example.test/device', async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).resolves.toBe('refuse');
    await expect(classifyPushEndpoint('https://push.example.test/device', async () => [{ address: '142.250.1.1', family: 4 }])).resolves.toBe('allow');
    await expect(classifyPushEndpoint('https://push.example.test/device', async () => { throw new Error('ENOTFOUND'); })).resolves.toBe('retry');
    await expect(classifyPushEndpoint('https://127.0.0.1/push', async () => [{ address: '142.250.1.1', family: 4 }])).resolves.toBe('refuse');
  });
});
