import express from 'express';
import { requireServerAuth } from '../middleware/requireServerAuth.js';
import {
  adjustPlayerBalance,
  connectPlayerSession,
  disconnectPlayerSession,
  heartbeatPlayerSession,
  heartbeatServer,
  loadPlayerBundle,
  savePlayerInventory,
  savePlayerProfile,
  transferPlayerBalance
} from '../services/networkService.js';

export const networkRouter = express.Router();

networkRouter.use(requireServerAuth);

networkRouter.post('/servers/heartbeat', async (req, res, next) => {
  try {
    const result = await heartbeatServer(req.serverId);
    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/sessions/connect', async (req, res, next) => {
  try {
    const result = await connectPlayerSession({
      serverId: req.serverId,
      playerId: req.body.playerId,
      displayName: req.body.displayName
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/sessions/heartbeat', async (req, res, next) => {
  try {
    const result = await heartbeatPlayerSession({
      serverId: req.serverId,
      playerId: req.body.playerId,
      sessionToken: req.body.sessionToken
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/sessions/disconnect', async (req, res, next) => {
  try {
    const result = await disconnectPlayerSession({
      serverId: req.serverId,
      playerId: req.body.playerId,
      sessionToken: req.body.sessionToken
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/players/:playerId/load', async (req, res, next) => {
  try {
    const result = await loadPlayerBundle({
      serverId: req.serverId,
      playerId: req.params.playerId,
      sessionToken: req.body.sessionToken
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.put('/players/:playerId/profile', async (req, res, next) => {
  try {
    const result = await savePlayerProfile({
      serverId: req.serverId,
      playerId: req.params.playerId,
      sessionToken: req.body.sessionToken,
      displayName: req.body.displayName,
      profile: req.body.profile,
      expectedRevision: req.body.expectedRevision
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.put('/players/:playerId/inventory', async (req, res, next) => {
  try {
    const result = await savePlayerInventory({
      serverId: req.serverId,
      playerId: req.params.playerId,
      sessionToken: req.body.sessionToken,
      inventory: req.body.inventory,
      expectedRevision: req.body.expectedRevision
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/players/:playerId/economy/adjust', async (req, res, next) => {
  try {
    const result = await adjustPlayerBalance({
      serverId: req.serverId,
      playerId: req.params.playerId,
      sessionToken: req.body.sessionToken,
      amount: req.body.amount,
      reason: req.body.reason,
      metadata: req.body.metadata
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

networkRouter.post('/economy/transfer', async (req, res, next) => {
  try {
    const result = await transferPlayerBalance({
      serverId: req.serverId,
      fromPlayerId: req.body.fromPlayerId,
      toPlayerId: req.body.toPlayerId,
      sessionToken: req.body.sessionToken,
      amount: req.body.amount,
      reason: req.body.reason,
      metadata: req.body.metadata
    });

    res.json({ status: 'ok', ...result });
  } catch (error) {
    next(error);
  }
});

