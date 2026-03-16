const express = require("express");
const cors = require("cors");
const path = require("path");
const { Resend } = require("resend");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY environment variable is not set.");
  process.exit(1);
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "KIS Grant Intelligence <onboarding@resend.dev>";

let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log("Resend email transport configured.");
} else {
  console.warn("WARNING: RESEND_API_KEY not set — email sending disabled.");
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
    email: !!resend,
  });
});

// Proxy endpoint — forwards requests to Anthropic
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

// Email sending endpoint via Resend
app.post("/api/send-email", async (req, res) => {
  const { to, grants } = req.body;

  if (!to || !grants || !grants.length) {
    return res.status(400).json({ error: "Missing required fields: to, grants" });
  }
  if (!resend) {
    return res.status(503).json({ error: "Email not configured. Add RESEND_API_KEY in Render environment variables." });
  }

  try {
    const weekStr = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });

    const grantDetails = grants.map((g, i) => `
Grant ${i + 1}: ${g.name}
Funder: ${g.funder}
Amount: ${g.amount}
Deadline: ${g.deadline}
Staff Wages Allowed: ${g.wagesAllowed}
Why it fits KIS: ${g.whyFits}
`).join("\n---\n");

    // Generate rich email content via Claude
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
        system: "You are a grant writing specialist for Kamloops Immigrant Services (KIS), a nonprofit in Kamloops, BC supporting immigrants, refugees, and newcomers. Write professional, detailed HTML email content with inline styles only.",
        messages: [{
          role: "user",
          content: `Generate the full HTML body content (inline styles only, no <html>/<head>/<body> tags) for a professional grant intelligence email for the KIS team. Week of: ${weekStr}

For EACH grant, include three clearly-headed sections:

1. GRANT OVERVIEW — Name, funder, amount, deadline, wages allowed, 2-sentence summary.
2. APPLICATION RECOMMENDATIONS — 4-6 specific tactical bullet points: narrative angle, which KIS programs to highlight, data to include, funder priorities to align with, tips to stand out.
3. FIRST DRAFT APPLICATION — A complete 400-600 word grant narrative ready to customize and submit, written in formal grant-writing style in KIS's voice. Include: compelling opening, community need in Kamloops, how funds will be used, expected outcomes, strong closing.

Use inline CSS. Navy blue (#1b2c6b) headings, red (#c8201e) section labels, clean Arial font, good spacing. Separate each grant with a horizontal divider.

Grants:
${grantDetails}

End with a reminder to review deadlines and customize before submitting. Sign off as: KIS Grant Intelligence Analyst — Powered by AI`
        }]
      })
    });

    const claudeData = await claudeResp.json();
    const emailBody = claudeData.content.map(b => b.text || "").join("");

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f9fc;font-family:Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:20px 16px;">
    <div style="background:linear-gradient(135deg,#111e4f,#1b2c6b);border-radius:12px;padding:28px 32px;margin-bottom:16px;">
      <p style="color:rgba(255,255,255,0.55);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 6px 0;">Kamloops Immigrant Services</p>
      <h1 style="color:white;font-size:22px;margin:0 0 6px 0;font-family:Arial,sans-serif;">Grant Intelligence Report</h1>
      <p style="color:rgba(255,255,255,0.65);font-size:13px;margin:0;">Week of ${weekStr} &middot; ${grants.length} Selected Grant${grants.length > 1 ? "s" : ""}</p>
    </div>
    <div style="background:white;border-radius:12px;padding:32px;margin-bottom:16px;">
      ${emailBody}
    </div>
    <p style="text-align:center;font-size:11px;color:#999;padding:8px 0;">
      Kamloops Immigrant Services &middot; Together We're Better<br>
      Generated by KIS Grant Intelligence Analyst
    </p>
  </div>
</body></html>`;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `KIS Grant Intelligence — ${grants.length} Selected Grant${grants.length > 1 ? "s" : ""} + Application Drafts · Week of ${weekStr}`,
      html,
    });

    if (error) {
      console.error("Resend error:", error);
      return res.status(500).json({ error: "Failed to send email: " + error.message });
    }

    res.json({ success: true, message: `Email sent to ${to}`, id: data.id });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Failed to send email: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KIS Grant Intelligence Server listening on port ${PORT}`);
});
