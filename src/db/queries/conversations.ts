import { pool } from '../../config/database';
import { Conversation, Message } from '../../types';

export interface ConversationRow {
  id: string;
  photographer_id: string; // FK → Photographer.userId
  client_id: string; // FK → Client.userId
  most_recent_message_id: string | null; // FK → Message.id — null until first message
  unread_for_photographer: number; // denormalised counter — unread by the photographer
  unread_for_client: number; // denormalised counter — unread by the client
  last_message_at: Date | null; // denormalised for inbox sort order
  created_at: Date;
}

// snake_case DB row -> camelCase Conversation.
export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    photographerId: row.photographer_id,
    clientId: row.client_id,
    mostRecentMessageId: row.most_recent_message_id,
    unreadForPhotographer: row.unread_for_photographer,
    unreadForClient: row.unread_for_client,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  sent_at: Date;
  read_at: Date | null;
}

// snake_case DB row -> camelCase Conversation.
export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    sentAt: row.sent_at,
    readAt: row.read_at,
  };
}

// All conversations for this client, most recent first.
// NULLS LAST is load-bearing: Postgres sorts nulls first under DESC, and a
// conversation with no messages yet has a null last_message_at — without it,
// every empty conversation pins above the active ones.
export async function getConversationsByClientId(clientId: string): Promise<Conversation[]> {
  const result = await pool.query<ConversationRow>(
    `SELECT *
     FROM conversations
     WHERE client_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [clientId],
  );
  return result.rows.map(toConversation);
}

// All conversations for this photographer, most recent first.
// See getConversationsByClientId for why NULLS LAST matters here.
export async function getConversationsByPhotographerId(
  photographerId: string,
): Promise<Conversation[]> {
  const result = await pool.query<ConversationRow>(
    `SELECT *
     FROM conversations
     WHERE photographer_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [photographerId],
  );
  return result.rows.map(toConversation);
}

// Single conversation by its own id.
export async function getConversationById(id: string): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(
    `SELECT *
     FROM conversations
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}

// One page of a conversation's messages, oldest first.
export async function getMessagesByConversation(
  id: string,
  limit: number,
  offset: number,
): Promise<Message[]> {
  const result = await pool.query<MessageRow>(
    `SELECT *
     FROM messages
     WHERE conversation_id = $1
     ORDER BY sent_at ASC
     LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );
  return result.rows.map(toMessage);
}

// Inserts a message and updates the conversation's denormalised fields as one
// unit. Only the recipient's unread counter moves — the CASE arms compare the
// sender against each side of the conversation, so a photographer's own message
// bumps unread_for_client and vice versa.
export async function sendMessageByConversation(
  id: string,
  senderId: string,
  content: string,
): Promise<Message> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // sent_at is left to its column DEFAULT NOW() (migration 008).
    const result = await client.query<MessageRow>(
      `INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, senderId, content],
    );

    const message = toMessage(result.rows[0]);

    await client.query(
      `UPDATE conversations
       SET most_recent_message_id = $1,
           last_message_at = NOW(),
           unread_for_photographer =
             unread_for_photographer + CASE WHEN photographer_id = $3 THEN 0 ELSE 1 END,
           unread_for_client =
             unread_for_client + CASE WHEN client_id = $3 THEN 0 ELSE 1 END
       WHERE id = $2`,
      [message.id, id, senderId],
    );

    await client.query('COMMIT');

    return message;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Zeroes only the caller's own unread counter — the other participant's is
// left alone. Setting = 0 in one statement is atomic and idempotent, so
// concurrent "mark read" calls can't drift the count.
export async function markConversationAsRead(
  id: string,
  userId: string,
): Promise<Conversation | null> {
  const result = await pool.query<ConversationRow>(
    `UPDATE conversations
     SET unread_for_photographer =
           CASE WHEN photographer_id = $2 THEN 0 ELSE unread_for_photographer END,
         unread_for_client =
           CASE WHEN client_id = $2 THEN 0 ELSE unread_for_client END
     WHERE id = $1
     RETURNING *`,
    [id, userId],
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}
