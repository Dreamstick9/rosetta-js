import { span, spansWidth, style, truncateSpans } from "./text.js";

const MAX_VISIBLE_ITEMS = 8;
const DIM = style("dim");
const CYAN = style("cyan");

export class Picker {
  constructor({ title, subtitle = "", items = null, searchable = false, onSelect, onCancel }) {
    Object.assign(this, { title, subtitle, searchable, onSelect, onCancel });
    this.query = "";
    this.setItems(items);
  }

  setItems(items) {
    this.items = items;
    this.index = Math.max(0, items?.findIndex((item) => item.current) ?? 0);
  }

  visibleItems() {
    if (!this.items) return [];
    const query = this.query.toLowerCase();
    return query ? this.items.filter((item) => item.label.toLowerCase().includes(query)) : this.items;
  }

  handleKey(key) {
    const items = this.visibleItems();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return this.onCancel();
    if (key.name === "up" || (key.ctrl && key.name === "p")) this.index = Math.max(0, this.index - 1);
    else if (key.name === "down" || (key.ctrl && key.name === "n")) this.index = Math.min(items.length - 1, this.index + 1);
    else if (key.name === "enter" && items[this.index]) this.onSelect(items[this.index]);
    else if (key.name === "backspace" && this.searchable) this.setQuery(this.query.slice(0, -1));
    else if (key.text && this.searchable) this.setQuery(this.query + key.text);
    else if (key.text && /^[1-9]$/.test(key.text) && items[Number(key.text) - 1]) this.onSelect(items[Number(key.text) - 1]);
  }

  setQuery(query) {
    this.query = query;
    this.index = 0;
  }

  render(width) {
    const lines = [[span("  "), span(this.title, style("bold"))]];
    if (this.subtitle) lines.push(truncateSpans([span(`  ${this.subtitle}`, DIM)], width));
    if (this.searchable) lines.push([span("  Search: ", DIM), span(this.query), span("▏", DIM)]);
    lines.push([]);
    lines.push(...this.renderItems(width));
    lines.push([]);
    const hint = `  ↑/↓ to select · enter to confirm · esc to go back${this.searchable ? " · type to search" : ""}`;
    lines.push(truncateSpans([span(hint, DIM)], width));
    return lines;
  }

  renderItems(width) {
    if (!this.items) return [[span("  Loading…", DIM)]];
    const items = this.visibleItems();
    if (items.length === 0) return [[span("  no matches", DIM)]];
    const start = Math.max(0, Math.min(this.index - Math.floor(MAX_VISIBLE_ITEMS / 2), items.length - MAX_VISIBLE_ITEMS));
    const shown = items.slice(start, start + MAX_VISIBLE_ITEMS);
    const labels = shown.map((item, offset) => `${start + offset + 1}. ${item.label}${item.current ? " (current)" : ""}`);
    const labelWidth = Math.min(Math.max(...labels.map((label) => label.length)), Math.floor(width / 2));
    return shown.map((item, offset) => {
      const selected = start + offset === this.index;
      const row = [span(selected ? "› " : "  ", CYAN), span(labels[offset], selected ? style("bold", "cyan") : "")];
      if (item.description) row.push(span(" ".repeat(Math.max(2, labelWidth - spansWidth([row[1]]) + 2))), span(item.description, selected ? CYAN : DIM));
      return truncateSpans(row, width);
    });
  }
}
