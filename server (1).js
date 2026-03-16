const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY environment variable is not set.");
  process.exit(1);
}

// Email transporter (Gmail SMTP)
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  console.log("Email transport configured for:", EMAIL_USER);
} else {
  console.warn("WARNING: EMAIL_USER or EMAIL_PASS not set — email sending disabled.");
}

// Serve the dashboard HTML at the root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "KIS Grant Intelligence Server running",
    ok: true,
    email: !!transporter,
  });
});

// Proxy endpoint — forwards requests to Anthropic, injects API key server-side
app.post("/api/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy server error: " + err.message });
  }
});

// Email sending endpoint
app.post("/api/send-email", async (req, res) => {
  const { to, subject, grants } = req.body;

  if (!to || !grants || !grants.length) {
    return res.status(400).json({ error: "Missing required fields: to, grants" });
  }
  if (!transporter) {
    return res.status(503).json({ error: "Email not configured on server. Add EMAIL_USER and EMAIL_PASS in Render environment variables." });
  }

  try {
    // Step 1: Use Claude to generate the rich email content
    const weekStr = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
    const grantDetails = grants.map((g, i) => `
Grant ${i + 1}: ${g.name}
Funder: ${g.funder}
Amount: ${g.amount}
Deadline: ${g.deadline}
Staff Wages Allowed: ${g.wagesAllowed}
Why it fits KIS: ${g.whyFits}
`).join("\n---\n");

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 6000,
        system: "You are a grant writing specialist for Kamloops Immigrant Services (KIS), a nonprofit in Kamloops, BC supporting immigrants, refugees, and newcomers. Write professional, detailed HTML email content.",
        messages: [{
          role: "user",
          content: `Generate the full HTML body (not a complete HTML document, just the body content with inline styles) for a professional grant intelligence email for the KIS team.

Week of: ${weekStr}

For EACH grant below, include these three clearly-headed sections styled with inline CSS:

1. GRANT OVERVIEW — Name, funder, amount, deadline, wages allowed, 2-sentence summary.
2. APPLICATION RECOMMENDATIONS — 4-6 specific tactical bullet points: narrative angle, which KIS programs to highlight, data to include, funder priorities to align with, what makes applications stand out.
3. FIRST DRAFT APPLICATION — A complete 400-600 word grant narrative ready to customize and submit, written in formal grant-writing style in KIS's voice. Include: compelling opening, community need, how funds will be used, expected outcomes, strong closing.

Style the email beautifully with inline CSS. Use navy blue (#1b2c6b) for headings, red (#c8201e) for section labels, clean sans-serif font, good spacing, and a clear visual hierarchy. Separate each grant with a horizontal rule.

Grants to process:
${grantDetails}

End with a brief reminder to review deadlines and customize drafts before submitting.
Sign off as: KIS Grant Intelligence Analyst — Powered by AI`
        }]
      })
    });

    const claudeData = await claudeResp.json();
    const emailBody = claudeData.content.map(b => b.text || "").join("");

    const htmlEmail = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 0; background: #f8f9fc;">
  <div style="background: linear-gradient(135deg, #111e4f, #1b2c6b); padding: 28px 32px; border-radius: 0 0 12px 12px;">
    <p style="color:rgba(255,255,255,0.55); font-size:11px; letter-spacing:2px; text-transform:uppercase; margin:0 0 6px;">Kamloops Immigrant Services</p>
    <h1 style="color:white; font-size:22px; margin:0 0 4px;">Grant Intelligence Report</h1>
    <p style="color:rgba(255,255,255,0.65); font-size:13px; margin:0;">Week of ${weekStr} · ${grants.length} Selected Grant${grants.length > 1 ? "s" : ""}</p>
  </div>
  <div style="background:white; padding:32px; border-radius:12px; margin:16px 0;">
    ${emailBody}
  </div>
  <p style="text-align:center; font-size:11px; color:#999; padding:16px;">
    Kamloops Immigrant Services · Together We're Better<br>
    Generated by KIS Grant Intelligence Analyst
  </p>
</body>
</html>`;

    // Step 2: Send the email
    await transporter.sendMail({
      from: `"KIS Grant Intelligence" <${EMAIL_USER}>`,
      to,
      subject: `KIS Grant Intelligence — ${grants.length} Selected Grant${grants.length > 1 ? "s" : ""} + Application Drafts · Week of ${weekStr}`,
      html: htmlEmail,
    });

    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Failed to send email: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KIS Grant Intelligence Server listening on port ${PORT}`);
  console.log(`Dashboard available at http://localhost:${PORT}`);
});
