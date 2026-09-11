import { Router, RequestHandler } from 'express';
import { Conversation, UserRole } from '../types';
import { AppError } from '../types/AppError';
import {
  getConversationById,
  getConversationsByClientId,
  getConversationsByPhotographerId,
  getMessagesByConversation,
  markConversationAsRead,
  sendMessageByConversation,
} from '../db/queries/conversations';
import cache from '../cache';
import { parsePaginationParam } from '../utils/pagination';

const router = Router();

// GET /conversations — both roles.
export const getConversations: RequestHandler = async (req, res, next) => {
  try {
    const isClient = req.user!.role === UserRole.client;
    const getFunction = isClient ? getConversationsByClientId : getConversationsByPhotographerId;
    const cacheKey = `conversations:${req.user!.id}`;

    let conversations = await cache.get<Conversation[]>(cacheKey);

    if (!conversations) {
      conversations = await getFunction(req.user!.id);
      await cache.set(cacheKey, conversations, 120);
    }

    res.status(200).json(conversations);
  } catch (err) {
    next(err);
  }
};

// GET /conversations/:id — both roles.
export const getConversationFromId: RequestHandler = async (req, res, next) => {
  try {
    const conversation = await getConversationById(req.params.id);

    if (!conversation) {
      return next(new AppError('Conversation not found', 404));
    }

    if (![conversation.clientId, conversation.photographerId].includes(req.user!.id)) {
      return next(new AppError('Unauthorized', 403));
    }
    res.status(200).json(conversation);
  } catch (err) {
    next(err);
  }
};

// GET /conversations/:id/messages — both roles, paginated like photos.
// Messages themselves are never cached — an inbox badge going stale is
// cheaper than a message list going stale.
const DEFAULT_MESSAGES_PAGE_SIZE = 50;
const MAX_MESSAGES_PAGE_SIZE = 100;

// content is a TEXT column, so Postgres itself imposes no useful ceiling.
// express.json()'s 100kb body limit catches the extreme cases, but a message
// only a little under that still lands in every inbox payload for this pair.
const MAX_MESSAGE_LENGTH = 5000;

export const getMessagesFromConversation: RequestHandler = async (req, res, next) => {
  try {
    const conversation = await getConversationById(req.params.id);

    if (!conversation) {
      return next(new AppError('Conversation not found', 404));
    }

    if (![conversation.clientId, conversation.photographerId].includes(req.user!.id)) {
      return next(new AppError('Unauthorized', 403));
    }

    const page = parsePaginationParam(req.query.page, 1);
    const limit = parsePaginationParam(
      req.query.limit,
      DEFAULT_MESSAGES_PAGE_SIZE,
      MAX_MESSAGES_PAGE_SIZE,
    );
    const messages = await getMessagesByConversation(conversation.id, limit, (page - 1) * limit);

    res.status(200).json(messages);
  } catch (err) {
    next(err);
  }
};

// POST /conversations/:id/messages — both roles.
export const addMessageToConversation: RequestHandler = async (req, res, next) => {
  try {
    // Load first: the conversation both authorises the write and tells us
    // whose list caches to invalidate afterwards.
    const conversation = await getConversationById(req.params.id);

    if (!conversation) {
      return next(new AppError('Conversation not found', 404));
    }

    if (![conversation.clientId, conversation.photographerId].includes(req.user!.id)) {
      return next(new AppError('Unauthorized', 403));
    }

    const { content } = req.body;

    if (typeof content !== 'string' || content.trim() === '') {
      return next(new AppError('content is required', 400));
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      return next(
        new AppError(`content must be ${MAX_MESSAGE_LENGTH} characters or fewer`, 400),
      );
    }

    // Postgres TEXT can't hold a null byte — one would fail at the insert and
    // surface as a 500, so strip rather than 400 on what is almost always an
    // encoding artefact rather than something the sender typed. Content is
    // stored raw otherwise: escaping happens at render time, not on the way in.
    const sanitised = content.replace(/\0/g, '');

    const message = await sendMessageByConversation(conversation.id, req.user!.id, sanitised);

    // Invalidate cache for both participants — last_message_at and the
    // recipient's unread counter both just changed.
    await Promise.all([
      cache.del(`conversations:${conversation.clientId}`),
      cache.del(`conversations:${conversation.photographerId}`),
    ]);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
};

// PATCH /conversations/:id/read — both roles, clears only the caller's counter.
export const markConversationRead: RequestHandler = async (req, res, next) => {
  try {
    // Authorise before mutating — this is a write, so a non-participant has to
    // be turned away before it runs, not after it has already zeroed a counter.
    const existing = await getConversationById(req.params.id);

    if (!existing) {
      return next(new AppError('Conversation not found', 404));
    }

    if (![existing.clientId, existing.photographerId].includes(req.user!.id)) {
      return next(new AppError('Unauthorized', 403));
    }

    const conversation = await markConversationAsRead(existing.id, req.user!.id);

    // Null only if the row was deleted between the load above and the update —
    // rare, but it's a 404 rather than a 200 with a null body.
    if (!conversation) {
      return next(new AppError('Conversation not found', 404));
    }

    await cache.del(`conversations:${req.user!.id}`);
    res.status(200).json(conversation);
  } catch (err) {
    next(err);
  }
};

router.get('/', getConversations);
router.get('/:id', getConversationFromId);
router.get('/:id/messages', getMessagesFromConversation);
router.post('/:id/messages', addMessageToConversation);
router.patch('/:id/read', markConversationRead);

export default router;
