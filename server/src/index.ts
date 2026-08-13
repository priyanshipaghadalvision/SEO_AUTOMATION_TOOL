import "dotenv/config";
import { createApp } from "./app.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
