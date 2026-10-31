import { Router } from 'express';
import auth from '../../middleware/auth.js';
import usersRouter from './users.js';

const router = Router();

// guards every router mounted below it
router.use(auth);
router.use('/users', usersRouter);

export default router;
