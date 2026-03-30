import express from 'express';

export const healthRouter = express.Router();

healthRouter.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'bedrock-network-backend',
    now: new Date().toISOString()
  });
});

