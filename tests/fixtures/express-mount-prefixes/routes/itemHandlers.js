export const listItems = (req, res) => res.json([]);
export const updateItem = (req, res) => res.json({ id: req.params.id });
export const removeItem = (req, res) => res.status(204).end();
