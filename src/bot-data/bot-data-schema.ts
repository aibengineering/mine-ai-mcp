import { readFileSync } from "node:fs";

export const BOT_DATA_SCHEMA = readFileSync(new URL("./bot-data.sql", import.meta.url), "utf8");
