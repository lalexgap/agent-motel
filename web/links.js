"use strict";
window.agentLinks = {
  url(text) {
    try {
      const url = new URL(text);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  },
  anchor(text, href = text) {
    const link = document.createElement("a");
    link.textContent = text;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  },
  render(node, text = "") {
    node.replaceChildren();
    return this.append(node, text);
  },
  append(node, text = "") {
    let offset = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let candidate = match[0], end = candidate.length;
      while (".,;:!?".includes(candidate[end - 1])) end--;
      candidate = candidate.slice(0, end);
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        let extra = candidate.split(close).length - candidate.split(open).length;
        end = candidate.length;
        while (extra-- > 0 && candidate[end - 1] === close) end--;
        candidate = candidate.slice(0, end);
      }
      const href = this.url(candidate);
      if (!href) continue;
      node.append(document.createTextNode(text.slice(offset, match.index)), this.anchor(candidate, href));
      offset = match.index + candidate.length;
    }
    node.append(document.createTextNode(text.slice(offset)));
    return node;
  },
  open(event, text) {
    const href = this.url(text);
    if (!event.isTrusted || !href) return;
    event.preventDefault();
    const link = this.anchor(text, href);
    document.body.append(link);
    link.click();
    link.remove();
  },
};
