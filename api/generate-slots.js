import { kv } from '@vercel/kv';

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const data = await kv.get('app-data');
    if (!data) return res.status(200).json({ added: 0 });
    if (!data.slots) data.slots = [];
    if (!data.availability) data.availability = { virtual: [], 'in-person': [] };
    if (!data.bookings) data.bookings = [];

    const bookedSlotIds = new Set(data.bookings.map(b => b.slotId));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayStr = today.getFullYear() + '-' + pad2(today.getMonth()+1) + '-' + pad2(today.getDate());
    const beforeCount = data.slots.length;
    data.slots = data.slots.filter(s => s.date >= todayStr || bookedSlotIds.has(s.id));
    const removed = beforeCount - data.slots.length;
    const existingMap = new Map();
    data.slots.forEach(s => existingMap.set(s.date + '|' + s.time + '|' + s.type, s));
    let added = 0;

    for (let i = 0; i < 8 * 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const dow = d.getDay();
      const ds = dateStr(d);
      for (const type of ['virtual', 'in-person']) {
        for (const rule of (data.availability[type] || [])) {
          if (!rule.days.includes(dow)) continue;
          let cursor = timeToMin(rule.start);
          const endMin = timeToMin(rule.end);
          while (cursor + 60 <= endMin) {
            const timeStr = pad2(Math.floor(cursor / 60)) + ':' + pad2(cursor % 60);
            const key = ds + '|' + timeStr + '|' + type;
            const existing = existingMap.get(key);
            if (!existing) {
              const slot = { id: Math.random().toString(36).slice(2, 10), date: ds, time: timeStr, duration: 60, type };
              data.slots.push(slot);
              existingMap.set(key, slot);
              added++;
            } else if (existing.duration !== 60 && !bookedSlotIds.has(existing.id)) {
              existing.duration = 60;
              added++;
            }
            cursor += 60;
          }
        }
      }
    }

    if (added > 0 || removed > 0) await kv.set('app-data', data);
    res.status(200).json({ added, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
