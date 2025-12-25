require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require("mongoose");

const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // index.html serve karega

// LongCat API setup
const longcat = new OpenAI({
  apiKey: process.env.LONGCAT_API_KEY,
  baseURL: 'https://api.longcat.chat/openai/v1',
});

// Smart max tokens function (frontend ke conversation ko consider kare)
function calculateMaxTokens(messages) {
  const approxTokens = messages.reduce((acc, m) => acc + m.content.length / 4, 0); // approx 4 chars per token
  const maxTokens = 2048 - Math.floor(approxTokens); // avoid hitting max
  return Math.min(Math.max(maxTokens, 512), 2048); // min 512, max 2048
}

/* =========================
   MongoDB Connection
========================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log(err));

/* =========================
   User Schema & Model
========================= */
// User Schema
const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, minlength: 2 },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true, minlength: 8 },
  mobile:    { type: String, sparse: true, default: null }, // optional
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Middleware to verify token
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Authentication required" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: "User not found" });

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ======================
//        ROUTES
// ======================
app.get('/', (req, res) => {
  res.send('index');
});

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, mobile } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      mobile: mobile || null
    });

    res.status(201).json({
      success: true,
      message: "Account created successfully"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        mobile: user.mobile
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Protected route example
app.get('/api/profile', authMiddleware, (req, res) => {
  res.json(req.user);
});


// Chat endpoint
// app.post('/api/chat', async (req, res) => {
//   try {
//     const { messages, stream } = req.body;

//     if (!messages || !Array.isArray(messages)) {
//       return res.status(400).json({ error: 'Messages array chahiye bhai' });
//     }

//     const max_tokens = calculateMaxTokens(messages);

//     const completion = await longcat.chat.completions.create({
//       model: 'LongCat-Flash-Chat',
//       messages,
//       temperature: 0.75,
//       max_tokens,
//       stream: stream || false, // frontend agar stream mode chahiye to true bheje
//     });

//     let reply = '';

//     if (completion.choices[0].delta) {
//       // Streamed response (agar stream true ho)
//       // Collecting final reply
//       completion.choices.forEach(c => {
//         if (c.delta?.content) reply += c.delta.content;
//       });
//     } else {
//       reply = completion.choices[0].message?.content || '';
//     }

//     res.json({ reply });
//   } catch (error) {
//     console.error('LongCat Error:', error?.response?.data || error.message);

//     let errorMsg = 'Kuch to gadbad hai...';
//     if (error?.response?.status === 429) errorMsg = 'Rate limit lag gaya bhai, thodi der baad try kar';
//     if (error?.response?.status === 401) errorMsg = 'API key galat hai ya expire ho gaya';

//     res.status(500).json({ error: errorMsg });
//   }
// });



// ... (existing requires and app setup)

// Chat Schema
const chatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New Chat' },
  messages: [{ role: { type: String }, content: { type: String } }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Chat = mongoose.model('Chat', chatSchema);

// Update chat endpoint (with auth and saving)
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { messages, stream = false, chatId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array chahiye bhai' });
    }

    const max_tokens = calculateMaxTokens(messages);

    // Decide streaming ya normal
    if (stream) {
      // === Streaming Mode ===
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let fullReply = '';

      const completion = await longcat.chat.completions.create({
        model: 'LongCat-Flash-Chat',
        messages,
        temperature: 0.75,
        max_tokens,
        stream: true,
      });

      for await (const chunk of completion) {
        const content = chunk.choices?.[0]?.delta?.content || '';
        if (content) {
          fullReply += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();

      // Save to DB after streaming complete
      await saveChatToDB(req.user._id, messages, fullReply, chatId);
    } else {
      // === Normal (non-streaming) Mode ===
      const completion = await longcat.chat.completions.create({
        model: 'LongCat-Flash-Chat',
        messages,
        temperature: 0.75,
        max_tokens,
        stream: false,
      });

      const reply = completion.choices?.[0]?.message?.content || '';

      // Send response
      res.json({ reply });

      // Save to DB
      await saveChatToDB(req.user._id, messages, reply, chatId);
    }
  } catch (error) {
    console.error('LongCat API Error:', error);

    // Agar headers already sent nahi hue to hi error bhejo
    if (!res.headersSent) {
      let errorMsg = 'Kuch to gadbad hai bhai...';
      if (error?.response?.status === 429) errorMsg = 'Rate limit lag gaya, thodi der baad try kar';
      if (error?.response?.status === 401) errorMsg = 'API key galat hai ya expire ho gaya';
      res.status(500).json({ error: errorMsg });
    }
  }
});

// Helper function for DB save (reusable)
async function saveChatToDB(userId, messages, reply, chatId) {
  let chat;

  if (chatId) {
    chat = await Chat.findOne({ _id: chatId, userId });
    if (!chat) throw new Error('Chat not found');
    
    // Append latest user + assistant message
    chat.messages.push(...messages.slice(-1)); // last user message
    chat.messages.push({ role: 'assistant', content: reply });
    chat.updatedAt = new Date();
  } else {
    const firstUserMsg = messages.find(m => m.role === 'user')?.content || 'New Chat';
    const title = firstUserMsg.slice(0, 50) + (firstUserMsg.length > 50 ? '...' : '');

    chat = await Chat.create({
      userId,
      title,
      messages: [
        ...messages,
        { role: 'assistant', content: reply }
      ],
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  await chat.save();
  return chat;
}

// Get recent chats (list for sidebar)
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user._id })
      .sort({ updatedAt: -1 }) // Newest first
      .limit(5) // Recent 5
      .select('_id title updatedAt');

    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: 'Chats load nahi hue' });
  }
});

// Get full chat by ID
app.get('/api/chats/:id', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOne({ _id: req.params.id, userId: req.user._id })
      .select('messages');

    if (!chat) return res.status(404).json({ error: 'Chat nahi mila' });

    res.json(chat.messages);
  } catch (err) {
    res.status(500).json({ error: 'Chat load nahi hua' });
  }
});
// Delete a specific chat
app.delete('/api/chats/:id', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat nahi mila ya tumhara nahi hai' });
    }

    res.json({ success: true, message: 'Chat deleted successfully' });
  } catch (err) {
    console.error('Delete chat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ... (rest of your app code)
// Start server
app.listen(port, () => {
  console.log(`Powerful LongCat AI chal raha hai → http://localhost:${port}`);
});

