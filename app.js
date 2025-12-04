const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_ID =
  process.env.GOOGLE_SHEET_ID || "1MeCb_ClcxP-H_e6vYid49l-ayRd0cF-TE_StXRO9dnM";
const TRANSACTION_SHEET_RANGE =
  process.env.GOOGLE_TRANSACTION_RANGE || "'2022'!A:H";
const TRANSACTION_COLUMNS = [
  "id",
  "date",
  "type",
  "category_id",
  "amount",
  "note",
];
const REQUIRED_TRANSACTION_COLUMNS = ["id", "date", "type", "amount"];
const CATEGORY_SHEET_RANGE =
  process.env.GOOGLE_CATEGORY_RANGE || "'categories'!A:C";
const CATEGORY_COLUMNS = ["id", "name", "color_hex"];
const DEFAULT_CATEGORY = {
  id: "1",
  name: "未分類",
  color_hex: "#9E9E9E",
};
const BUDGET_SHEET_RANGE = process.env.GOOGLE_BUDGET_RANGE || "'budgets'!A:B";
const BUDGET_COLUMNS = ["id", "amount"];
const DEFAULT_BUDGET = {
  id: "1",
  amount: "0",
};
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "gonsakon";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "!Nba1q2w3e4r";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";
const API_ENDPOINTS = [
  { method: "GET", path: "/api/transactions", description: "取得所有記帳資料" },
  { method: "GET", path: "/api/transactions/:keyword", description: "查詢專案" }
];

/**
 * Reuse the Google Sheets client so we do not re-authenticate on every request.
 */
const buildCredentialsFromEnv = () => {
  const requiredKeys = [
    "GOOGLE_SA_TYPE",
    "GOOGLE_SA_PROJECT_ID",
    "GOOGLE_SA_PRIVATE_KEY_ID",
    "GOOGLE_SA_PRIVATE_KEY",
    "GOOGLE_SA_CLIENT_EMAIL",
    "GOOGLE_SA_CLIENT_ID",
  ];

  const hasAll = requiredKeys.every((key) => !!process.env[key]);
  if (!hasAll) {
    return null;
  }

  return {
    type: process.env.GOOGLE_SA_TYPE,
    project_id: process.env.GOOGLE_SA_PROJECT_ID,
    private_key_id: process.env.GOOGLE_SA_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_SA_CLIENT_ID,
  };
};

const getSheetsClient = (() => {
  let cached;
  return () => {
    if (cached) return cached;

    const credentials = buildCredentialsFromEnv();
    const auth = new google.auth.GoogleAuth({
      ...(credentials
        ? { credentials }
        : {
            keyFile:
              process.env.GOOGLE_APPLICATION_CREDENTIALS ||
              path.join(
                __dirname,
                "sunlit-adviser-479406-r0-b5a712496697.json"
              ),
          }),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    cached = google.sheets({ version: "v4", auth });
    return cached;
  };
})();

const normalizeRows = (rows) => {
  if (!rows || rows.length === 0) {
    return [];
  }

  const [header, ...dataRows] = rows;
  return dataRows.map((row) =>
    header.reduce((acc, key, index) => {
      acc[key] = row[index] ?? "";
      return acc;
    }, {})
  );
};

const appendRow = async (sheets, range, columns, payload) => {
  const row = columns.map((key) => {
    const value = payload[key];
    return value === undefined || value === null ? "" : value;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });
};

/**
 * 找出指定 id 在工作表中的列索引（0-based，不含標題列）
 * 回傳 { rowIndex, rowData } 或 null
 */
const findRowById = async (sheetRange, idColumn, targetId) => {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetRange,
  });

  const rows = response.data.values || [];
  if (rows.length < 2) return null;

  const [header, ...dataRows] = rows;
  const idIndex = header.indexOf(idColumn);
  if (idIndex === -1) return null;

  const normalizedTarget = (targetId ?? "").toString().trim();
  for (let i = 0; i < dataRows.length; i++) {
    const rowId = (dataRows[i][idIndex] ?? "").toString().trim();
    if (rowId === normalizedTarget) {
      const rowData = header.reduce((acc, key, idx) => {
        acc[key] = dataRows[i][idx] ?? "";
        return acc;
      }, {});
      return { rowIndex: i + 2, rowData }; // +2: 1 for 1-based, 1 for header
    }
  }
  return null;
};

/**
 * 更新指定列的資料
 */
const updateRow = async (sheetName, rowIndex, columns, payload) => {
  const sheets = getSheetsClient();
  const row = columns.map((key) => {
    const value = payload[key];
    return value === undefined || value === null ? "" : value;
  });

  const range = `'${sheetName}'!A${rowIndex}:${String.fromCharCode(
    64 + columns.length
  )}${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row],
    },
  });
};

/**
 * 刪除指定列（使用 batchUpdate 刪除整列）
 */
const deleteRow = async (sheetName, rowIndex) => {
  const sheets = getSheetsClient();

  // 先取得 sheetId
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const sheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheet) {
    throw new Error(`找不到工作表: ${sheetName}`);
  }

  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex - 1, // 0-based
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });
};

const generateToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const requireAuth = (req, res, next) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "未授權：請提供 token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "token 無效或已過期" });
  }
};

app.get("/", (req, res) => {
  res.json({
    message: "Google Sheets 商品 API",
    sheetId: SHEET_ID,
    endpoints: API_ENDPOINTS,
  });
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "帳號或密碼錯誤" });
  }

  const token = generateToken({ username });
  res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

const listTransactionsHandler = async (req, res) => {
  try {
    const sheets = getSheetsClient();
    // const response = await sheets.spreadsheets.values
    //   .get({
    //     spreadsheetId: SHEET_ID,
    //     range: TRANSACTION_SHEET_RANGE,
    //   })
    //   .catch((error) => {
    //     if (error.code === 400 || error.code === 404) {
    //       return { data: { values: [], errors: error } };
    //     }
    //     throw error;
    //   });

    // console.log(response);

    // const transactions = normalizeRows(response.data.values);

    // const data = transactions.map((transaction) => {
    //   return {
    //     ...transaction
    //   };
    // });

    // 先取得試算表的 metadata
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    // 抓出所有工作表名稱
    let results = [];
    const sheetNames = meta.data.sheets.map((s) => s.properties.title);
    console.log("所有分頁：", sheetNames);

    // 逐一讀取每個分頁
    for (const name of sheetNames) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${name}!A:Z`, // 假設讀取 A 到 Z 欄
      });

      // const transactions = normalizeRows(response.data.values);

      // results.push(transactions.map((transaction) => {
      //   return {
      //     ...transaction
      //   };
      // }));

      const rows = response.data.values || [];
      if (rows.length < 2) continue;

      const header = rows[0];
      let timeIndex = header.findIndex(h =>
        h && h.replace(/\s/g, "").toLowerCase().includes("日期") ||
        h && h.replace(/\s/g, "").toLowerCase().includes("時間") ||
        h && h.toLowerCase().includes("date")
      );

      let nameIndex = header.findIndex(h =>
        h && h.replace(/\s/g, "").toLowerCase().includes("案件")
      );

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.some(cell => cell)) {
          let timeVal = timeIndex !== -1 ? row[timeIndex] : "未填日期";
          let caseVal = nameIndex !== -1 ? row[nameIndex] : "";
          const content = row.filter((_, idx) => idx !== timeIndex && idx !== nameIndex);
          results.push({ sheet: name, time: timeVal, caseName: caseVal, content: content });
        }
      }

    }

    results.sort((a, b) => {
      const da = isNaN(Date.parse(a.time)) ? new Date(0) : new Date(a.time);
      const db = isNaN(Date.parse(b.time)) ? new Date(0) : new Date(b.time);
      return db - da;
    });

    res.json({results});
  } catch (error) {
    console.log(res);
    console.error("Failed to fetch transaction data:", error);
    res.status(500).json({ message: "無法讀取專案資料", error: error.message });
  }
};

app.get("/api/transactions", listTransactionsHandler);

// PUT /api/transactions/:id - 更新記帳資料
app.get("/api/transactions/:keyword", async (req, res) => {
  try {
    const { keyword } = req.params;

    const sheets = getSheetsClient();

    // 先取得試算表的 metadata
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    // 抓出所有工作表名稱
    let results = [];
    const sheetNames = meta.data.sheets.map((s) => s.properties.title);
    console.log("所有分頁：", sheetNames);

    // 逐一讀取每個分頁
    for (const name of sheetNames) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${name}!A:Z`, // 假設讀取 A 到 Z 欄
      });

      const rows = response.data.values || [];
      if (rows.length < 2) continue;

      const header = rows[0];
      let timeIndex = header.findIndex(h =>
        h && h.replace(/\s/g, "").toLowerCase().includes("日期") ||
        h && h.replace(/\s/g, "").toLowerCase().includes("時間") ||
        h && h.toLowerCase().includes("date")
      );

      let nameIndex = header.findIndex(h =>
        h && h.replace(/\s/g, "").toLowerCase().includes("案件")
      );

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.some(cell => cell && cell.includes(keyword))) {
          let timeVal = timeIndex !== -1 ? row[timeIndex] : "未填日期";
          let caseVal = nameIndex !== -1 ? row[nameIndex] : "";
          const content = row.filter((_, idx) => idx !== timeIndex && idx !== nameIndex);
          results.push({ sheet: name, time: timeVal, caseName: caseVal, content: content });
        }
      }
    }

    results.sort((a, b) => {
      const da = isNaN(Date.parse(a.time)) ? new Date(0) : new Date(a.time);
      const db = isNaN(Date.parse(b.time)) ? new Date(0) : new Date(b.time);
      return db - da;
    });

    res.json({results});
  } catch (error) {
    console.error("Failed to update transaction:", error);
    res.status(500).json({ message: "無法查詢資料", error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
