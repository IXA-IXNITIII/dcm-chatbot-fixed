require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.set('trust proxy', 1); // Render อยู่หลัง proxy ต้องตั้งค่านี้ ไม่งั้น rate limit นับ IP ผิด
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // เสิร์ฟไฟล์ Frontend

// จำกัดจำนวนคำขอ ป้องกันคนยิง API จนโควตา Gemini หมด
app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { reply: 'ส่งข้อความถี่เกินไป กรุณารอสักครู่แล้วลองใหม่ครับ' }
}));

// ตั้งค่าการเชื่อมต่อ PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // จำเป็นสำหรับการเชื่อมต่อบน Cloud
});
pool.on('error', (err) => console.error('PG pool error:', err));

// สร้างตารางเก็บประวัติแชทอัตโนมัติหากยังไม่มี (ไม่ลบข้อมูลเดิม)
const initDB = async () => {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS chat_logs (
            id SERIAL PRIMARY KEY,
            user_message TEXT NOT NULL,
            bot_reply TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    await pool.query(createTableQuery);
};
initDB().catch((e) => console.error('initDB failed:', e));

// ตั้งค่า AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// เปลี่ยนโมเดลได้ที่ Environment บน Render (GEMINI_MODEL) โดยไม่ต้องแก้โค้ด
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const systemInstruction = `
คุณคือ AI ผู้ช่วยแนะแนวการศึกษาของ "หลักสูตรสารสนเทศศาสตรบัณฑิต สาขาดิจิทัลคอนเทนต์และสื่อ" (Digital Content and Media) สำนักวิชาสารสนเทศศาสตร์ มหาวิทยาลัยวลัยลักษณ์
ข้อมูลหลักสูตร:
- ปรัชญา: มุ่งผลิตบัณฑิตให้มีสมรรถนะด้านดิจิทัลคอนเทนต์ เชี่ยวชาญเทคโนโลยี มีคุณธรรม
- จุดเด่น: จัดการคอนเทนต์ดิจิทัลกลุ่มหอศิลป์ ห้องสมุด พิพิธภัณฑ์ (Digital GLAM), สหกิจศึกษา 8 เดือน, ได้มาตรฐานสากล UKPSF
- อาชีพ: Digital Content Creator, Web Content Manager, Digital Collection Developer, Web Designer
- ค่าธรรมเนียม: 25,000 บาท/เทอม (รวมตลอดหลักสูตร 200,000 บาท)
- โครงสร้าง: 123 หน่วยกิต เลือกเรียนภาษาจีนหรืออังกฤษได้ 
- การรับสมัคร: รับนักศึกษาทุกแผนการเรียน ประมาณ 70 คน/ปี ยื่นแฟ้มสะสมผลงาน (Portfolio) เกรดเฉลี่ยขั้นต่ำ 2.75 สมัครที่ https://entry.wu.ac.th/
- ภาษา: เลือกเรียนภาษาจีน หรือเลือกเรียนวิชาเฉพาะที่สอนเป็นภาษาอังกฤษ 50% (ตั้งแต่ชั้นปีที่ 2)
- เว็บไซต์หลักสูตรทางการ: https://informatics.wu.ac.th/bachelors-degree/digital-content-and-media/

กฎสำคัญในการตอบ:
1. หากผู้ใช้ถามเป็นภาษาไทย ให้ตอบเป็นภาษาไทย
2. หากผู้ใช้ถามเป็นภาษาอังกฤษ ให้ตอบเป็นภาษาอังกฤษ (Translate the program details accurately into English)
3. ตอบคำถามอย่างเป็นมิตร สุภาพ และอ้างอิงจากข้อมูลหลักสูตรเป็นหลัก
4. หากไม่มีข้อมูลในหลักสูตรที่ให้ไว้ ให้บอกตรง ๆ ว่าไม่ทราบ และแนะนำให้ติดต่อสำนักวิชาสารสนเทศศาสตร์หรือดูเว็บไซต์หลักสูตรทางการ ห้ามเดาข้อมูล
5. ตอบเป็นข้อความธรรมดา ไม่ใช้สัญลักษณ์ Markdown (เช่น ** หรือ #) และตอบให้กระชับ
`;

// API Endpoint สำหรับแชท
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body && req.body.message;

    // ตรวจสอบ input
    if (typeof userMessage !== 'string' || !userMessage.trim() || userMessage.length > 1000) {
        return res.status(400).json({ reply: 'กรุณาพิมพ์ข้อความ (ไม่เกิน 1,000 ตัวอักษร)' });
    }

    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: userMessage,
            config: {
                systemInstruction: systemInstruction,
            }
        });

        // กรณี Gemini ไม่ตอบ (เช่นถูก safety filter) ใช้ข้อความสำรอง
        const botReply = response.text || 'ขออภัย ไม่สามารถตอบคำถามนี้ได้ กรุณาลองถามใหม่อีกครั้งครับ';

        // บันทึกแยกออกมา ถ้า DB พังก็ยังตอบผู้ใช้ได้
        pool.query(
            'INSERT INTO chat_logs (user_message, bot_reply) VALUES ($1, $2)',
            [userMessage, botReply]
        ).catch((e) => console.error('Log failed:', e));

        res.json({ reply: botReply });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ reply: "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
