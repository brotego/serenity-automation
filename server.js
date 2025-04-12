import express from 'express';
import puppeteer from 'puppeteer-core';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(bodyParser.json());

let browser = null;
let evaluationsSinceLaunch = 0;
const queue = [];
let isProcessingQueue = false;

async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 60000,
  });
  console.log('🚀 Puppeteer browser launched');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function maybeRestartBrowser() {
  evaluationsSinceLaunch++;
  if (evaluationsSinceLaunch >= 10) {
    console.log('♻️ Restarting browser to free memory');
    await browser.close();
    await delay(1000);
    await launchBrowser();
    evaluationsSinceLaunch = 0;
  }
}

async function processQueue() {
  if (isProcessingQueue || queue.length === 0) return;
  isProcessingQueue = true;

  while (queue.length > 0) {
    const { name, portfolio_url, focus, res } = queue.shift();

    if (!portfolio_url) {
      console.log(`⚠️ Missing portfolio URL for ${name}`);
      res.status(400).send('Missing portfolio URL');
      continue;
    }

    if (!browser) {
      console.log('⚠️ Browser was null, relaunching');
      await launchBrowser();
    }

    const startTime = Date.now();
    console.log(`\n🧐 Starting evaluation for: ${name} | ${portfolio_url} | ${focus}`);

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      try {
        await page.goto(portfolio_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (err) {
        console.warn(`⚠️ Failed to fully load ${portfolio_url}, continuing anyway`);
      }

      const screenshotPath = path.join(__dirname, 'temp', `${name.replace(/\s+/g, '_')}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const imageBuffer = fs.readFileSync(screenshotPath);
      const base64Image = imageBuffer.toString('base64');

      const role = focus?.toLowerCase() || 'general';

      const prompt = `You're a creative director evaluating this portfolio for multiple potential roles: ${role}.

Please analyze the portfolio from the perspective of **each individual role**. Be specific.

Here are the role-specific criteria to use:

**${role.charAt(0).toUpperCase() + role.slice(1)}**: Use your best judgment.

---

**Structure your response like this:**

**As a Photographer:**
- Mention product photography?
- Vibrant color use?
- Youthful energy?
- Strong visual storytelling?

**As an Influencer:**
- On-camera personality?
- GRWM/skits/tutorials/UGC vibe?
- Platform-native style?
- Natural but polished presentation?

(Repeat for any other role.)

At the end of your analysis, provide a summary line with a rating based on how well this portfolio fits the roles:
**Rating: good**

Use only one of these three: **okay**, **good**, or **amazing**.`;

      const t1 = Date.now();
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          max_tokens: 1000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: base64Image
                  }
                }
              ]
            }
          ]
        })
      });

      if (!anthropicResponse.ok) throw new Error(`AI response error: ${anthropicResponse.statusText}`);

      const resultJson = await anthropicResponse.json();
      console.log(`🧠 AI response time: ${Date.now() - t1}ms`);

      await page.close();
      await maybeRestartBrowser();

      console.log(`✅ Done evaluating: ${name} | Took ${Date.now() - startTime}ms`);
      res.status(200).send(resultJson.content?.[0]?.text || 'No response');
    } catch (err) {
      console.error(`❌ Error during evaluation for ${name}:`, err.message);
      res.status(500).send('Error during evaluation');
    }
  }

  isProcessingQueue = false;
}

app.post('/evaluate', (req, res) => {
  const { name, portfolio_url, focus } = req.body;
  queue.push({ name, portfolio_url, focus, res });
  processQueue();
});

app.listen(PORT, async () => {
  await launchBrowser();
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
