# Concierge dock history evidence

Base: 790dc2fbe26d51a0e5c2b75eee4f0fb978740de3. After: 4b5dbe0965c1a6b1ef45e32ffe0633fb8586a830.

Headless mobile Chromium, 390 x 844 CSS pixels with viewport meta. Isolated fixture loads real heading, stylesheet, renderer and refreshDock from each revision; transcript/API are mocked. Capture waits for the button background transition to settle before taking screenshots. A reply is appended while scrolled to the first displayed message. Before removes that message; after retains it at the same 16px scroller-relative offset with 21 displayed messages. No horizontal overflow.

This is Concierge dock evidence, not authenticated full-app or physical-device verification, and not evidence for the separate full Agent Chat issue.
