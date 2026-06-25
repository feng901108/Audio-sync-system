import { createAdmin, adminCount, findAdminByUsername } from "./auth.mjs";

const username = process.argv[2] ?? "admin";
const password = process.argv[3] ?? "admin";

if (findAdminByUsername(username)) {
  console.log(`管理员 ${username} 已存在，未做修改。`);
  process.exit(0);
}

createAdmin(username, password);
console.log(`已创建管理员：${username} / ${password}`);
console.log(`当前管理员总数：${adminCount()}`);
