// server/index.js
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

/* ----------------- uploads dir ----------------- */
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log('Created uploads directory at', UPLOADS_DIR);
}

/* ----------------- middleware ----------------- */
app.use(cors({
  origin: ['http://localhost:5173', 'https://khata-bot.web.app/'], // update frontend URL
}));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

/* ----------------- MongoDB ----------------- */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wknmybf.mongodb.net/dokanLedgerDB?retryWrites=true&w=majority&appName=Cluster0`;
mongoose.connect(uri)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

/* ----------------- Schemas ----------------- */
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true, unique: true },
  uid: { type: String, required: true, unique: true },
});
const User = mongoose.model('User', userSchema);

const historySchema = new mongoose.Schema({
  uid: { type: String, required: true },
  imagePath: { type: String, required: true },
  aiResult: { type: Object },
  isCreditSale: { type: Boolean, default: false },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String },
  ownerUid: { type: String, required: true }, // Links to the shop owner's Firebase UID
  totalDue: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Customer = mongoose.model('Customer', customerSchema);

/* ----------------- multer ----------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

/* ----------------- Google Generative AI ----------------- */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let SELECTED_GEMINI_MODEL = process.env.GEMINI_MODEL || null;

async function detectGeminiModel(apiKey) {
  if (!apiKey) return null;
  try {
    const fetchFn = global.fetch || require('node-fetch');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const r = await fetchFn(url);
    const body = await r.json();
    if (!Array.isArray(body.models)) return null;
    const candidates = body.models
      .map(m => m.name.replace(/^models\//, ''))
      .filter(name => name.startsWith('gemini') && !name.includes('embed'));
    return candidates[0] || null;
  } catch (err) {
    console.error('detectGeminiModel error:', err);
    return null;
  }
}
(async () => {
  if (!SELECTED_GEMINI_MODEL) {
    SELECTED_GEMINI_MODEL = await detectGeminiModel(process.env.GEMINI_API_KEY);
    console.log('Using Gemini model:', SELECTED_GEMINI_MODEL || 'gemini-1.5-flash');
  }
})();

/* helper: convert file to base64 */
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: fs.readFileSync(filePath).toString('base64'),
      mimeType
    }
  };
}

/* ----------------- Routes ----------------- */
app.get('/', (req, res) => res.send('Dokan Ledger AI Server is running!'));

// upsert user
app.post('/users', async (req, res) => {
  const user = req.body;
  if (!user?.uid) return res.status(400).send({ message: 'Missing uid' });
  try {
    const updated = await User.findOneAndUpdate(
      { uid: user.uid },
      user,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).send(updated);
  } catch (err) {
    res.status(500).send({ message: 'Error saving user', error: err.message });
  }
});

// upload + AI extraction
app.post('/api/upload', upload.single('ledgerImage'), async (req, res) => {
  const { uid, isCreditSale, customerId } = req.body;
  if (!req.file) return res.status(400).send({ message: 'No file uploaded.' });
  if (!uid) return res.status(400).send({ message: 'Missing uid.' });
  if (isCreditSale === 'true' && !customerId) {
    return res.status(400).send({ message: 'Customer must be selected for a credit sale.' });
  }

  try {
    const modelName = SELECTED_GEMINI_MODEL || 'gemini-1.5-flash';
    const prompt = `Analyze this image of a handwritten sales ledger from Bangladesh. 
    Extract itemName, quantity, price. Return ONLY valid JSON array.`;

    const imagePart = fileToGenerativePart(req.file.path, req.file.mimetype);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();

    let aiJsonResult = null;
    try {
      aiJsonResult = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).send({ message: 'AI response not valid JSON', rawResponse: responseText });
    }

    const newHistoryEntry = new History({
      uid,
      imagePath: `/uploads/${req.file.filename}`,
      aiResult: aiJsonResult,
      isCreditSale: isCreditSale === 'true',
      customerId: isCreditSale === 'true' ? customerId : null
    });
    await newHistoryEntry.save();

    if (newHistoryEntry.isCreditSale) {
      const saleTotal = aiJsonResult.reduce((total, item) => {
        return total + (Number(item.quantity) * Number(item.price));
      }, 0);
      await Customer.findByIdAndUpdate(customerId, { $inc: { totalDue: saleTotal } });
    }

    res.status(200).send({ message: 'Ledger processed!', history: newHistoryEntry });
  } catch (err) {
    res.status(500).send({ message: 'Upload error', error: err.message });
  }
});

// history by user
app.get('/api/history', async (req, res) => {
  if (!req.query.uid) return res.status(400).send({ message: 'Missing uid' });
  try {
    const history = await History.find({ uid: req.query.uid }).sort({ createdAt: -1 });
    res.status(200).send(history);
  } catch (err) {
    res.status(500).send({ message: 'History fetch error', error: err.message });
  }
});

// monthly dashboard + AI insights
app.get('/api/dashboard/monthly', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).send({ message: 'Missing uid' });

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const analytics = await History.aggregate([
      { $match: { uid, createdAt: { $gte: start, $lte: end } } },
      { $unwind: '$aiResult' },
      {
        $project: {
          itemName: '$aiResult.itemName',
          quantity: { $ifNull: [{ $toDouble: '$aiResult.quantity' }, 0] },
          price: { $ifNull: [{ $toDouble: '$aiResult.price' }, 0] }
        }
      },
      {
        $group: {
          _id: '$itemName',
          totalQuantitySold: { $sum: '$quantity' },
          totalRevenue: { $sum: { $multiply: ['$quantity', '$price'] } }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ]);

    const totalRevenue = analytics.reduce((a, b) => a + (b.totalRevenue || 0), 0);

    let aiInsights = "এই মাসের জন্য কোনো বিশ্লেষণ পাওয়া যায়নি।";
    if (analytics.length > 0 && process.env.GEMINI_API_KEY) {
      try {
        const topProducts = analytics.slice(0, 3)
          .map(p => `${p._id || 'Unknown'} (৳${p.totalRevenue.toFixed(2)})`).join(', ');
        const prompt = `আপনি একজন দোকান ব্যবসায় পরামর্শদাতা। 
        এই মাসের মোট বিক্রি: ৳${totalRevenue.toFixed(2)} 
        শীর্ষ পণ্য: ${topProducts} 
        ব্যবসায়ীর জন্য ২-৩টি সহজ, বন্ধুত্বপূর্ণ ও কার্যকর পরামর্শ দিন (বাংলায়)।`;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent(prompt);
        aiInsights = result.response.text().trim();
      } catch (err) {
        console.error('AI insights error:', err);
      }
    }

    res.status(200).send({ totalRevenue, bestSellers: analytics, aiInsights });
  } catch (err) {
    res.status(500).send({ message: 'Dashboard error', error: err.message });
  }
});

// update history
app.put('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  const { uid, aiResult } = req.body;

  if (!uid || !aiResult) {
    return res.status(400).send({ message: 'Missing uid or aiResult data.' });
  }

  try {
    const historyEntry = await History.findById(id);
    if (!historyEntry) {
      return res.status(404).send({ message: 'History entry not found.' });
    }
    if (historyEntry.uid !== uid) {
      return res.status(403).send({ message: 'Forbidden: You do not have permission to edit this entry.' });
    }

    historyEntry.aiResult = aiResult;
    await historyEntry.save();

    res.status(200).send({ message: 'History updated successfully.', history: historyEntry });
  } catch (error) {
    console.error('Error updating history:', error);
    res.status(500).send({ message: 'Error updating history entry.', error });
  }
});

/* ----------------- Customer Routes ----------------- */
app.get('/api/customers', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send({ message: 'Missing owner uid.' });

  try {
    const customers = await Customer.find({ ownerUid: uid }).sort({ name: 1 });
    res.status(200).send(customers);
  } catch (error) {
    res.status(500).send({ message: "Error fetching customers.", error });
  }
});

app.post('/api/customers', async (req, res) => {
  const { name, phone, ownerUid } = req.body;
  if (!name || !ownerUid) {
    return res.status(400).send({ message: 'Missing name or owner uid.' });
  }

  try {
    const newCustomer = new Customer({ name, phone, ownerUid });
    await newCustomer.save();
    res.status(201).send(newCustomer);
  } catch (error) {
    res.status(500).send({ message: 'Error creating customer.', error });
  }
});

/* ----------------- NEW: Credit Summary ----------------- */
app.get('/api/dashboard/credit-summary', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send({ message: 'Missing owner uid.' });

  try {
    const result = await Customer.aggregate([
      { $match: { ownerUid: uid } },
      { $group: { _id: null, totalBaki: { $sum: '$totalDue' } } }
    ]);
    const totalBaki = result.length > 0 ? result[0].totalBaki : 0;
    res.status(200).send({ totalBaki });
  } catch (error) {
    console.error("Error fetching credit summary:", error);
    res.status(500).send({ message: "Error fetching credit summary.", error });
  }
});

/* ----------------- Start server ----------------- */
app.listen(port, () => {
  console.log(`🚀 Server running on port: ${port}`);
});
