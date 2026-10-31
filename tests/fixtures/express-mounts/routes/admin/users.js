import { Router } from 'express';

const router = Router();

router.post('/:id/block', (req, res) => res.json({ blocked: req.params.id }));
router.delete('/:id', (req, res) => res.status(204).end());

export default router;
