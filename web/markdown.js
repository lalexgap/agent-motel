"use strict";
// Builds DOM nodes only (never innerHTML), so agent text cannot inject markup.
window.agentMarkdown = {
  fence: /^\s{0,3}(`{3,}|~{3,})/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/,
  rule: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableDivider: /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/,
  maxDepth: 8,
  maxRender: 100000,
  render(node, text = "") {
    text = String(text);
    node.replaceChildren();
    if (text.length > this.maxRender) window.agentLinks.append(this.element("p", node), text);
    else this.blocks(node, text.replace(/\r\n?/g, "\n").split("\n"));
    return node;
  },
  element(tag, parent) {
    const node = document.createElement(tag);
    parent.append(node);
    return node;
  },
  startsBlock(lines, index) {
    const line = lines[index];
    return this.fence.test(line) || this.heading.test(line) || this.rule.test(line) ||
      this.quote.test(line) || this.item.test(line) || this.isTable(lines, index);
  },
  isTable(lines, index) {
    return lines[index].includes("|") && index + 1 < lines.length && this.tableDivider.test(lines[index + 1].trim()) && lines[index + 1].includes("|");
  },
  cells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
  },
  blocks(parent, lines, depth = 0) {
    if (depth > this.maxDepth) {
      window.agentLinks.append(this.element("p", parent), lines.join("\n").trim());
      return;
    }
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      const fence = line.match(this.fence);
      if (fence) {
        const body = [];
        index++;
        while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
        index++;
        const pre = this.element("pre", parent);
        window.agentLinks.render(this.element("code", pre), body.join("\n"));
        continue;
      }
      const heading = line.match(this.heading);
      if (heading) {
        this.inline(this.element(["h3", "h4", "h5", "h5", "h5", "h5"][heading[1].length - 1], parent),
          (heading[2] ?? "").trimEnd().replace(/(?:^|[ \t])#+$/, "").trim());
        index++;
        continue;
      }
      if (this.rule.test(line)) {
        this.element("hr", parent);
        index++;
        continue;
      }
      if (this.quote.test(line)) {
        const body = [];
        while (index < lines.length && this.quote.test(lines[index])) body.push(lines[index++].replace(this.quote, ""));
        this.blocks(this.element("blockquote", parent), body, depth + 1);
        continue;
      }
      if (this.isTable(lines, index)) {
        const wrap = this.element("div", parent);
        wrap.className = "md-table";
        const table = this.element("table", wrap);
        const head = this.element("tr", this.element("thead", table));
        for (const cell of this.cells(line)) this.inline(this.element("th", head), cell);
        const body = this.element("tbody", table);
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const row = this.element("tr", body);
          for (const cell of this.cells(lines[index++])) this.inline(this.element("td", row), cell);
        }
        continue;
      }
      const item = line.match(this.item);
      if (item) {
        index = this.list(parent, lines, index, item[1].length, depth);
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && (!paragraph.length || !this.startsBlock(lines, index)))
        paragraph.push(lines[index++].trim());
      this.inline(this.element("p", parent), paragraph.join("\n"));
    }
  },
  list(parent, lines, index, indent, depth) {
    const ordered = /\d/.test(lines[index].match(this.item)[2]);
    const list = this.element(ordered ? "ol" : "ul", parent);
    const start = Number.parseInt(lines[index].match(this.item)[2], 10);
    if (ordered && start > 1) list.setAttribute("start", String(start));
    while (index < lines.length) {
      const match = lines[index].match(this.item);
      if (!match || match[1].length < indent || match[1].length > indent + 1 || /\d/.test(match[2]) !== ordered) break;
      const li = this.element("li", list);
      const nested = [];
      index++;
      while (index < lines.length) {
        const next = lines[index];
        const child = next.match(this.item);
        if (child && child[1].length <= indent + 1) break;
        if (!next.trim()) {
          const following = lines[index + 1] ?? "";
          if (following.search(/\S/) <= indent + 1) break;
          nested.push("");
          index++;
          continue;
        }
        if (!/^\s/.test(next) && !child) {
          if (nested.length || this.startsBlock(lines, index)) break;
          match[3] += "\n" + next.trim();
          index++;
          continue;
        }
        nested.push(next.slice(Math.min(next.search(/\S/), indent + 2)));
        index++;
      }
      this.inline(li, match[3]);
      if (nested.length) this.blocks(li, nested, depth + 1);
    }
    return index;
  },
  inlinePattern: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)?)\)|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|(https?:\/\/[^\s<>"'`]+)/gi,
  maxInline: 10000,
  inline(parent, text) {
    if (text.length > this.maxInline) return window.agentLinks.append(parent, text);
    let offset = 0;
    for (const match of text.matchAll(this.inlinePattern)) {
      window.agentLinks.append(parent, text.slice(offset, match.index));
      offset = match.index + match[0].length;
      if (match[1]) this.element("code", parent).textContent = match[2].trim() ? match[2].replace(/^ (.*) $/s, "$1") : match[2];
      else if (match[3] || match[4]) this.inline(this.element("strong", parent), match[3] || match[4]);
      else if (match[5]) this.inline(this.element("del", parent), match[5]);
      else if (match[6]) {
        const href = window.agentLinks.url(match[7]);
        if (!href) window.agentLinks.append(parent, match[0]);
        else parent.append(Object.assign(window.agentLinks.anchor(match[6], href), { title: href }));
      } else if (match[10]) window.agentLinks.append(parent, match[0]);
      else this.inline(this.element("em", parent), match[8] || match[9]);
    }
    window.agentLinks.append(parent, text.slice(offset));
    return parent;
  },
};
