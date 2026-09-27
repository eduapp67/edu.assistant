/* ============================================================
   CẤU HÌNH FIREBASE — điền thông tin dự án Firebase của bạn
   ------------------------------------------------------------
   Lấy ở: Firebase Console → Project settings → Your apps → Web app
   → mục "SDK setup and configuration" → chọn "Config".

   Đoạn cấu hình web của Firebase KHÔNG phải mật khẩu — nó được
   thiết kế để công khai. Dữ liệu được bảo vệ bởi Firestore Rules
   (file firestore.rules), nên đưa file này lên GitHub là bình thường.

   Để trống (giữ nguyên "YOUR_...") → app chạy chế độ
   "chỉ lưu trên máy này", không cần đăng nhập.
============================================================ */
window.EDU_FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
