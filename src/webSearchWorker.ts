import { searchConversations } from "./webSearch";
const query = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(await searchConversations(query)));
