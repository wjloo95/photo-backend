jest.mock('../../config/env', () => ({
  env: { EMAIL_FROM: 'no-reply@sysphoto.local' },
}));

import { consoleSender } from '../consoleSender';

describe('consoleSender', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prints the recipient, subject, sender and body', async () => {
    await consoleSender.send({
      to: 'client@example.com',
      subject: 'Your photos will be deleted in 30 days',
      text: 'Hi Casey Client,',
    });

    const output = logged.join('\n');
    expect(output).toContain('client@example.com');
    expect(output).toContain('Your photos will be deleted in 30 days');
    expect(output).toContain('no-reply@sysphoto.local');
    expect(output).toContain('Hi Casey Client,');
  });

  // It says so on the tin, but it matters: the expiry processor marks an album
  // warned on a resolved send, so if this ever started rejecting, albums would
  // silently stop being marked and the deletion gate would hold them forever.
  it('resolves rather than throwing', async () => {
    await expect(
      consoleSender.send({ to: 'a@b.c', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
  });

  // Being visibly not-a-real-send is the point — this adapter exists so the
  // pipeline runs without credentials, and a log line that looked like a
  // delivery receipt would be actively misleading.
  it('labels the output as not actually sent', async () => {
    await consoleSender.send({ to: 'a@b.c', subject: 's', text: 't' });

    expect(logged.join('\n')).toContain('not actually sent');
  });
});
