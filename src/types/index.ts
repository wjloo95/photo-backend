/**
 * src/types/index.ts
 *
 * TypeScript interfaces for all 12 database entities.
 * Each interface mirrors one table in the PostgreSQL schema exactly —
 * same fields, same nullability, same naming (camelCase here, snake_case in DB).
 *
 * See README.md in this folder for a full explanation of how and why these work.
 */

// ─────────────────────────────────────────────
// Enums — mirror PostgreSQL ENUM types
// ─────────────────────────────────────────────

export enum UserRole {
  photographer = 'photographer',
  client = 'client',
}

export enum AlbumType {
  shoot = 'shoot',
  portfolio = 'portfolio',
}

export enum PhotoStatus {
  processing = 'processing',
  ready = 'ready',
}

export enum InviteStatus {
  pending = 'pending',
  accepted = 'accepted',
  expired = 'expired',
}

export enum AnswerType {
  text = 'text',
  multipleChoice = 'multiple_choice',
  date = 'date',
  boolean = 'boolean',
}

export enum VisibilityType {
  public = 'public',
  private = 'private',
}

// ─────────────────────────────────────────────
// Auth & Users
// ─────────────────────────────────────────────

/**
 * Core user record — created by Auth0 webhook on signup.
 * Shared by both photographers and clients.
 */
export interface User {
  id: string;           // UUID primary key
  email: string;
  name: string;
  role: UserRole;
  providerId: string;   // Auth0/Clerk external reference (provider_id in DB)
  joinedAt: Date;
}

/**
 * Photographer profile — one-to-one with User (where role = 'photographer').
 * user_id is both the FK to User and the primary key of this table.
 */
export interface Photographer {
  userId: string;             // FK → User.id (also acts as PK)
  bio: string;
  profilePhotoUrl: string;    // Cloudinary path
  instagramHandle: string;
  visibility: VisibilityType;
}

/**
 * Client profile — one-to-one with User (where role = 'client').
 * Always linked to a single photographer (invite-only signup).
 */
export interface Client {
  userId: string;         // FK → User.id (also acts as PK)
  photographerId: string; // FK → Photographer.userId
}

// ─────────────────────────────────────────────
// Photos & Albums
// ─────────────────────────────────────────────

/**
 * Album — a collection of photos, either a client shoot or a portfolio.
 * access_expires_at = shoot_date + 3 years.
 * warned_*_at fields track which expiry warning emails have been sent.
 */
export interface Album {
  id: string;
  photographerId: string;       // FK → Photographer.userId
  clientId: string | null;      // FK → Client.userId — null for portfolio albums
  thumbnailPhotoId: string | null; // FK → Photo.id — null until set
  type: AlbumType;
  shootDate: Date;
  accessExpiresAt: Date;
  warned90At: Date | null;
  warned30At: Date | null;
  warned7At: Date | null;
  createdAt: Date;
}

/**
 * Photo — metadata record only. The actual image bytes live in Cloudinary.
 *
 * base_path convention: all three variants are derived from this single field:
 *   {base_path}/original.jpg
 *   {base_path}/standard.jpg
 *   {base_path}/thumbnail.jpg
 *
 * This means only one DB field is needed to represent three image variants.
 */
export interface Photo {
  id: string;
  basePath: string;         // Cloudinary key prefix
  status: PhotoStatus;      // 'processing' until Cloudinary confirms; then 'ready'
  width: number | null;     // null until the processor reads it back from Cloudinary
  height: number | null;    // null until the processor reads it back from Cloudinary
  uploadedAt: Date;
}

/**
 * PhotoAlbum — join table linking Photos to Albums.
 * A photo can belong to multiple albums.
 */
export interface PhotoAlbum {
  photoId: string;    // FK → Photo.id
  albumId: string;    // FK → Album.id
  addedAt: Date;
  isCover: boolean;
}

// ─────────────────────────────────────────────
// Messaging
// ─────────────────────────────────────────────

/**
 * Conversation — one per photographer–client pair.
 * Auto-created in the same transaction as the Client record on invite acceptance.
 *
 * mostRecentMessageId and numberofUnread are denormalised for inbox performance:
 * - mostRecentMessageId avoids a subquery to find the latest message.
 * - numberOfUnread avoids a COUNT query on every inbox load.
 * Both must be kept in sync when messages are sent/read.
 */
export interface Conversation {
  id: string;
  photographerId: string;               // FK → Photographer.userId
  clientId: string;                     // FK → Client.userId
  mostRecentMessageId: string | null;   // FK → Message.id — null until first message
  numberOfUnread: number;               // denormalised counter
  lastMessageAt: Date | null;           // denormalised for inbox sort order
  createdAt: Date;
}

/**
 * Message — a single message within a conversation.
 * read_at = NULL means unread.
 */
export interface Message {
  id: string;
  conversationId: string; // FK → Conversation.id
  senderId: string;       // FK → User.id
  content: string;
  sentAt: Date;
  readAt: Date | null;    // NULL = unread
}

// ─────────────────────────────────────────────
// Forms & Questionnaires
// ─────────────────────────────────────────────

/**
 * FormTemplate — a reusable questionnaire created by a photographer.
 * Can be assigned to multiple clients.
 */
export interface FormTemplate {
  id: string;
  photographerId: string; // FK → Photographer.userId
  name: string;
  createdAt: Date;
}

/**
 * FormQuestion — a single question within a template.
 * order controls display sequence.
 */
export interface FormQuestion {
  id: string;
  templateId: string;   // FK → FormTemplate.id
  content: string;
  answerType: AnswerType;
  order: number;
}

/**
 * FormResponse — one instance of a template assigned to a specific client.
 * submitted_at = NULL means the client has started but not yet submitted.
 */
export interface FormResponse {
  id: string;
  templateId: string;           // FK → FormTemplate.id
  clientId: string;             // FK → Client.userId
  startedAt: Date;
  submittedAt: Date | null;     // NULL = in progress
}

/**
 * FormAnswer — a client's answer to one question in a response.
 */
export interface FormAnswer {
  id: string;
  responseId: string;   // FK → FormResponse.id
  questionId: string;   // FK → FormQuestion.id
  content: string;
}

// ─────────────────────────────────────────────
// Invites
// ─────────────────────────────────────────────

/**
 * Invite — photographer-initiated client onboarding link.
 * token is a cryptographically random one-time-use string.
 * expires 30 days from creation.
 * accepted_at is set when the client completes signup via the link.
 */
export interface Invite {
  id: string;
  photographerId: string;   // FK → Photographer.userId
  email: string;
  clientName: string;       // pre-filled by photographer
  token: string;            // crypto random, one-time use
  status: InviteStatus;
  expiresAt: Date;
  acceptedAt: Date | null;  // NULL until accepted
  createdAt: Date;
}
