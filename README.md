# 🤖 RoboAI Trợ Giảng — Chatbot Giọng Nói Dùng Gemini API

Ứng dụng web tương tác giọng nói dành cho đề tài giáo dục: học sinh nói vào micro, hệ thống nhận diện giọng nói theo thời gian thực, gửi lên **Gemini API (Streaming SSE)** để xử lý tốc độ cao, hiển thị nhân vật **Robot biểu cảm đồng bộ khẩu hình & sóng âm**, phát giọng đọc qua loa (TTS) và lưu **lịch sử hỏi đáp**.

## ✨ Tính năng chính

1. **Nhân vật Robot AI biểu cảm (`public/robot.js`)**
   - 5 trạng thái trực quan: *Sẵn sàng*, *Đang lắng nghe*, *Đang suy nghĩ*, *Đang nói chuyện*, *Thông báo lỗi*.
   - Chớp mắt tự nhiên, mắt dõi theo con trỏ, miệng LED nhảy theo nhịp đọc, vòng sóng âm Canvas phản hồi trực tiếp theo âm lượng micro.
   - Hiển thị **phụ đề trực tiếp** và **thời gian phản hồi (ms)** để học sinh quan sát tốc độ AI.
2. **Nhận diện giọng nói & Phát âm tốc độ cao (`public/speech.js`)**
   - **Speech-to-Text (STT):** Dùng Web Speech API (`vi-VN` / `en-US`) hiện chữ trực tiếp khi đang nói; tự động dự phòng ghi âm gửi thẳng cho Gemini nếu trình duyệt không hỗ trợ Web Speech API.
   - **Text-to-Speech (TTS):** Đọc cuốn chiếu từng câu ngay khi Gemini đang stream chữ về để giảm độ trễ tối đa.
   - Chế độ **Liên tục (Hands-free)**: Tự bật lại mic sau khi Robot trả lời xong.
   - Phím tắt `Space` để bật/tắt Mic nhanh.
3. **Lịch sử hỏi đáp & Tùy biến lớp học (`public/app.js`)**
   - Chọn môn học (*Tổng hợp*, *Khoa học vui*, *Toán & Logic*, *Lịch sử & Văn*, *Luyện Tiếng Anh*) và cấp học (*Tiểu học*, *THCS*, *THPT*).
   - Nút **Đọc lại**, **Sao chép**, **Xóa**, và **Lưu lịch sử (.md)**.

## 🚀 Cách chạy nhanh

### 1. Cấu hình Gemini API Key
Tạo file `.env` từ `.env.example`:

```bash
cp .env.example .env
```

Mở `.env` và dán API key lấy từ Google AI Studio (`GEMINI_API_KEY=...`).  
*(Hoặc bỏ qua bước này và nhập trực tiếp API Key trong nút **⚙️ Cài đặt** trên giao diện web).*

### 2. Khởi động Server (không cần cài thêm thư viện ngoài)

```bash
npm start
```

Sau đó mở trình duyệt **Google Chrome** hoặc **Microsoft Edge** tại địa chỉ:
- `http://localhost:3000`

> **Lưu ý:** Chrome/Edge yêu cầu `http://localhost` (hoặc `https://`) để cấp quyền Micro.

## 🍓 Chạy trên Raspberry Pi gắn màn hình & mic (Chế độ Kiosk)

1. Cài Node.js (>= 18) trên Raspberry Pi OS.
2. Chạy server bằng `node server.js`.
3. Mở Chromium ở chế độ toàn màn hình:
   ```bash
   chromium-browser --kiosk http://localhost:3000
   ```
4. Nếu Chromium trên Raspberry Pi không có sẵn gói giọng đọc tiếng Việt trong `speechSynthesis`, có thể cài `espeak-ng` hoặc dùng Chrome trên PC/Mini PC Windows để có giọng đọc tiếng Việt tự nhiên nhất.
