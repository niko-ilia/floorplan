import { Router } from 'express';
import auth from '../middleware/auth.js';
import { listItems, updateItem, removeItem } from './itemHandlers.js';

const router = Router();

router.get('/', listItems);
// named handlers after the check
router.put('/:id', auth, updateItem);
router.delete('/:id', removeItem);

export default router;
