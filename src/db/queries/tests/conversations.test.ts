jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import {
  getConversationById,
  getConversationsByClientId,
  getConversationsByPhotographerId,
  getMessagesByConversation,
  markConversationAsRead,
  sendMessageByConversation,
} from '../conversations';
import { pool } from '../../../config/database';

const mockQuery = pool.query as jest.Mock;
const mockConnect = pool.connect as jest.Mock;

// A checked-out client for the transaction in sendMessageByConversation.
// Returns the message row for the INSERT and an empty result for everything
// else (BEGIN/COMMIT/the conversation UPDATE, which the function ignores).
const makeTxClient = (messageRow: object) => {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [messageRow] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
};

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
});

const messageRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'msg-1',
  conversation_id: 'convo-1',
  sender_id: 'photog-1',
  content: 'hello',
  sent_at: new Date('2026-01-02T00:00:00Z'),
  read_at: null,
  ...overrides,
});

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'convo-1',
  photographer_id: 'photog-1',
  client_id: 'client-1',
  most_recent_message_id: null,
  unread_for_photographer: 0,
  unread_for_client: 0,
  last_message_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('getConversationsByClientId', () => {
  it('maps found rows from snake_case to the Conversation shape', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] });

    const result = await getConversationsByClientId('client-1');

    expect(result).toEqual([
      {
        id: 'convo-1',
        photographerId: 'photog-1',
        clientId: 'client-1',
        mostRecentMessageId: null,
        unreadForPhotographer: 0,
        unreadForClient: 0,
        lastMessageAt: null,
        createdAt: row().created_at,
      },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM conversations'), ['client-1']);
  });

  // Postgres sorts nulls FIRST under DESC, and an unmessaged conversation has a
  // null last_message_at — without NULLS LAST every empty conversation would
  // pin to the top of the inbox.
  it('orders by last_message_at DESC with NULLS LAST', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getConversationsByClientId('client-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY last_message_at DESC NULLS LAST'),
      ['client-1'],
    );
  });

  it('returns an empty array when no rows are found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getConversationsByClientId('missing-client');

    expect(result).toEqual([]);
  });
});

describe('getConversationsByPhotographerId', () => {
  it('returns every conversation row, not just the first', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row({ id: 'convo-1', client_id: 'client-1' }),
        row({ id: 'convo-2', client_id: 'client-2' }),
      ],
    });

    const result = await getConversationsByPhotographerId('photog-1');

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['convo-1', 'convo-2']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM conversations'), ['photog-1']);
  });

  it('orders by last_message_at DESC with NULLS LAST', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getConversationsByPhotographerId('photog-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY last_message_at DESC NULLS LAST'),
      ['photog-1'],
    );
  });

  it('returns an empty array when the photographer has no conversations', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getConversationsByPhotographerId('photog-1');

    expect(result).toEqual([]);
  });
});

describe('getConversationById', () => {
  it('maps a found row to the Conversation shape', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] });

    const result = await getConversationById('convo-1');

    expect(result).toEqual({
      id: 'convo-1',
      photographerId: 'photog-1',
      clientId: 'client-1',
      mostRecentMessageId: null,
      unreadForPhotographer: 0,
      unreadForClient: 0,
      lastMessageAt: null,
      createdAt: row().created_at,
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['convo-1']);
  });

  it('returns null when no row is found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await getConversationById('missing-id');

    expect(result).toBeNull();
  });
});

describe('getMessagesByConversation', () => {
  it('maps rows to the Message shape and passes limit/offset through', async () => {
    mockQuery.mockResolvedValue({ rows: [messageRow()] });

    const result = await getMessagesByConversation('convo-1', 50, 100);

    expect(result).toEqual([
      {
        id: 'msg-1',
        conversationId: 'convo-1',
        senderId: 'photog-1',
        content: 'hello',
        sentAt: messageRow().sent_at,
        readAt: null,
      },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), [
      'convo-1',
      50,
      100,
    ]);
  });

  it('returns an empty array when the conversation has no messages on that page', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    expect(await getMessagesByConversation('convo-1', 50, 0)).toEqual([]);
  });
});

describe('sendMessageByConversation', () => {
  it('inserts the message and commits, returning the created message', async () => {
    const txClient = makeTxClient(messageRow());
    mockConnect.mockResolvedValue(txClient);

    const result = await sendMessageByConversation('convo-1', 'photog-1', 'hello');

    expect(result).toEqual({
      id: 'msg-1',
      conversationId: 'convo-1',
      senderId: 'photog-1',
      content: 'hello',
      sentAt: messageRow().sent_at,
      readAt: null,
    });
    const statements = txClient.query.mock.calls.map((call) => call[0]);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(txClient.release).toHaveBeenCalled();
  });

  it('bumps each side conditionally on the sender, so the sender never marks their own message unread', async () => {
    const txClient = makeTxClient(messageRow());
    mockConnect.mockResolvedValue(txClient);

    await sendMessageByConversation('convo-1', 'photog-1', 'hello');

    const [sql, params] = txClient.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE conversations'),
    )!;
    expect(sql).toContain('unread_for_photographer + CASE WHEN photographer_id = $3 THEN 0 ELSE 1 END');
    expect(sql).toContain('unread_for_client + CASE WHEN client_id = $3 THEN 0 ELSE 1 END');
    // $3 is the sender — that's what makes the CASE arms pick a side.
    expect(params).toEqual(['msg-1', 'convo-1', 'photog-1']);
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const dbError = new Error('insert failed');
    const txClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO messages')) return Promise.reject(dbError);
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(txClient);

    await expect(sendMessageByConversation('convo-1', 'photog-1', 'hello')).rejects.toThrow(
      'insert failed',
    );
    expect(txClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(txClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(txClient.release).toHaveBeenCalled();
  });
});

describe('markConversationAsRead', () => {
  it('zeroes only the callers side, passing the caller as $2', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ unread_for_client: 4 })] });

    const result = await markConversationAsRead('convo-1', 'photog-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('CASE WHEN photographer_id = $2 THEN 0 ELSE unread_for_photographer END');
    expect(sql).toContain('CASE WHEN client_id = $2 THEN 0 ELSE unread_for_client END');
    expect(params).toEqual(['convo-1', 'photog-1']);
    // The other participant's counter comes back untouched.
    expect(result?.unreadForClient).toBe(4);
  });

  it('returns null when the conversation does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    expect(await markConversationAsRead('missing-id', 'photog-1')).toBeNull();
  });
});
