// Plain TypeScript shared by both sides: no runtime calls.
interface Item {
  id: string;
  count: number;
}

function addItem(items: Map<string, Item>, id: string, count: number): Item {
  const item = items.get(id) ?? { id, count: 0 };
  item.count += count;
  items.set(id, item);
  return item;
}
