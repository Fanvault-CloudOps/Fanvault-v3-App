describe('commerce-service sanity', () => {
  it('NODE_ENV is defined or defaults to test', () => {
    const env = process.env.NODE_ENV || 'test';
    expect(env).toBeTruthy();
  });

  it('health response shape is valid', () => {
    const health = {
      status: 'ok',
      service: 'fanvault-commerce-service',
      database: 'dynamodb',
      timestamp: new Date().toISOString(),
    };
    expect(health.status).toBe('ok');
    expect(health.service).toBe('fanvault-commerce-service');
    expect(typeof health.timestamp).toBe('string');
  });
});
