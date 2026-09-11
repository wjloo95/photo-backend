-- Migration 014: indexes
-- Adds indexes to columns that will appear in WHERE clauses frequently.
-- No new tables — only performance optimisations on existing tables.
--
-- Rule of thumb: index foreign key columns (PostgreSQL does NOT do this automatically),
-- columns used in equality lookups (token, provider_id), and
-- columns used in range queries or ORDER BY (expires_at, access_expires_at).

-- clients: look up all clients for a photographer
CREATE INDEX idx_clients_photographer_id ON clients(photographer_id);

-- albums: look up all albums for a photographer or client
CREATE INDEX idx_albums_photographer_id ON albums(photographer_id);
CREATE INDEX idx_albums_client_id ON albums(client_id);
-- expiry pipeline queries albums approaching their expiry date
CREATE INDEX idx_albums_access_expires_at ON albums(access_expires_at);

-- photo_albums: look up all photos in an album (most common read path)
CREATE INDEX idx_photo_albums_album_id ON photo_albums(album_id);
CREATE INDEX idx_photo_albums_photo_id ON photo_albums(photo_id);

-- conversations: look up conversations for a photographer or client
CREATE INDEX idx_conversations_photographer_id ON conversations(photographer_id);
CREATE INDEX idx_conversations_client_id ON conversations(client_id);

-- messages: look up all messages in a conversation, sorted by time
CREATE INDEX idx_messages_conversation_id_sent_at ON messages(conversation_id, sent_at DESC);

-- form_responses: look up all responses for a client
CREATE INDEX idx_form_responses_client_id ON form_responses(client_id);
CREATE INDEX idx_form_responses_template_id ON form_responses(template_id);

-- form_answers: look up all answers in a response
CREATE INDEX idx_form_answers_response_id ON form_answers(response_id);

-- invites: token lookup on link click (must be fast — it's a public endpoint)
CREATE INDEX idx_invites_token ON invites(token);
-- look up pending invites for a photographer
CREATE INDEX idx_invites_photographer_id ON invites(photographer_id);
-- expiry pipeline scans for invites past their expiry date
CREATE INDEX idx_invites_expires_at ON invites(expires_at);
