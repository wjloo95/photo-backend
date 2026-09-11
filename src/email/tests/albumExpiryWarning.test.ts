import { albumExpiryWarning } from '../templates/albumExpiryWarning';

const base = {
  clientEmail: 'client@example.com',
  clientName: 'Casey Client',
  shootDate: new Date('2026-01-15T00:00:00Z'),
  accessExpiresAt: new Date('2029-01-15T00:00:00Z'),
};

describe('albumExpiryWarning', () => {
  it('addresses the message to the client', () => {
    expect(albumExpiryWarning({ ...base, days: 90 }).to).toBe('client@example.com');
  });

  it.each([90, 30] as const)('names the countdown in the subject at %i days', (days) => {
    expect(albumExpiryWarning({ ...base, days }).subject).toBe(
      `Your photos will be deleted in ${days} days`,
    );
  });

  // The 7-day notice is the last one that goes out before an irreversible
  // deletion, so it has to read differently from the two reminders before it.
  it('marks the 7-day message as the final notice', () => {
    const message = albumExpiryWarning({ ...base, days: 7 });

    expect(message.subject).toContain('Final notice');
    expect(message.text).toContain('last reminder');
  });

  it('carries both the shoot date and the deletion date', () => {
    const { text } = albumExpiryWarning({ ...base, days: 30 });

    expect(text).toContain('2026-01-15');
    expect(text).toContain('2029-01-15');
  });

  // An unqualified "01/02/2029" means two different days depending on where
  // the reader lives, which is a bad property for a final deletion notice.
  it('formats dates as unambiguous ISO calendar days', () => {
    const { text } = albumExpiryWarning({ ...base, days: 7 });

    expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it('greets the client by name when there is one', () => {
    expect(albumExpiryWarning({ ...base, days: 90 }).text).toContain('Hi Casey Client,');
  });

  // users.name defaults to '' in the schema and the join can produce null, so
  // the template must not render "Hi null,".
  it('falls back to a bare greeting when the name is missing', () => {
    const { text } = albumExpiryWarning({ ...base, clientName: null, days: 90 });

    expect(text).toContain('Hi,');
    expect(text).not.toContain('null');
  });

  it('always says the deletion is permanent', () => {
    for (const days of [90, 30, 7] as const) {
      expect(albumExpiryWarning({ ...base, days }).text).toMatch(/permanent|cannot be recovered/);
    }
  });
});
