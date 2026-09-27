# EDU ASSISTANT — Sổ tay giáo viên

Ứng dụng web gọn nhẹ giúp giáo viên theo dõi lớp học hằng ngày. Chạy ngay trên trình duyệt (máy tính, điện thoại), cài được lên màn hình chính như một app và dùng được cả khi mất mạng.

## Tính năng

| Phần | Làm được gì |
|---|---|
| **Lớp học** | Tạo lớp, thêm học sinh (dán cả danh sách từ Excel/Word, mỗi dòng một em), sửa tên, xoá. |
| **Buổi học** | Điểm danh (có mặt / vắng / muộn), checklist bài tập 3 mức, bài luyện tập có điểm (theo số câu đúng hoặc thang 10), chép phạt, ghi chú riêng từng em, tổng kết điểm buổi. Xuất báo cáo buổi học ra Word và tạo prompt báo cáo cho AI. |
| **Báo cáo** | Báo cáo từng học sinh (chuyên cần, hoàn thành bài tập, bảng các buổi, nhận xét tự động), báo cáo cả lớp (biến động từng buổi, biểu đồ, phân bố học lực), xuất Word, copy tin nhắn Zalo gửi phụ huynh, tạo prompt infographic tổng kết buổi học. |
| **Tiến độ** | Tra nhanh theo tên học sinh, biểu đồ điểm so với trung bình lớp. |
| **Tài khoản** | Đăng nhập bằng ID + mật khẩu riêng, đồng bộ nhiều thiết bị, sao lưu / khôi phục bằng file. |

## Dữ liệu được lưu thế nào

- Mỗi giáo viên có **tài khoản riêng** (ID + mật khẩu). Giáo viên này không xem được dữ liệu của giáo viên khác — được đảm bảo bởi `firestore.rules`.
- Dữ liệu được lưu **ngay trên thiết bị** (localStorage + bộ đệm ngoại tuyến của Firestore) nên mở app rất nhanh và vẫn nhập liệu được khi mất mạng. Khi có mạng lại, app **tự đồng bộ** lên Firestore.
- Đăng nhập cùng ID trên máy khác sẽ thấy đủ dữ liệu. Nếu một dữ liệu bị sửa trên hai máy, bản sửa sau cùng được giữ.
- Khi **đăng xuất**, bản đệm của tài khoản trên máy đó bị xoá (an toàn cho máy dùng chung).
- Nếu chưa cấu hình Firebase, app vẫn chạy ở chế độ **chỉ lưu trên máy này** (không cần đăng nhập).

## Cấu trúc thư mục

```
├── index.html            # Trang chính
├── styles.css            # Giao diện
├── app.js                # Toàn bộ logic ứng dụng
├── firebase-config.js    # ← ĐIỀN cấu hình Firebase của bạn vào đây
├── sw.js                 # Service worker: chạy offline, cài lên màn hình chính
├── manifest.json         # Thông tin app (PWA)
├── icons/                # Biểu tượng app
├── firestore.rules       # Quy tắc bảo mật Firestore
└── .nojekyll             # Để GitHub Pages phục vụ nguyên trạng các file
```

## Cài đặt (khoảng 15 phút)

### 1. Tạo dự án Firebase

1. Vào [Firebase Console](https://console.firebase.google.com) → **Add project** → đặt tên (VD: `edu-assistant`). Có thể tắt Google Analytics.
2. **Build → Authentication → Get started → Sign-in method** → bật **Email/Password** → Save.
   > App ghép ID thành dạng `id@edu-assistant.app` để dùng đăng nhập Email/Password — giáo viên chỉ cần nhớ ID, không cần email thật.
3. **Build → Firestore Database → Create database** → chọn vị trí (VD `asia-southeast1`) → chế độ **Production**.
4. Trong Firestore, tab **Rules** → dán toàn bộ nội dung file `firestore.rules` → **Publish**.
5. **Project settings (⚙) → Your apps → biểu tượng `</>` (Web)** → đặt tên app → Register. Sao chép đoạn `firebaseConfig`.

### 2. Điền cấu hình

Mở `firebase-config.js`, thay các giá trị `YOUR_...` bằng giá trị vừa sao chép:

```js
window.EDU_FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "edu-assistant-xxxx.firebaseapp.com",
  projectId: "edu-assistant-xxxx",
  storageBucket: "edu-assistant-xxxx.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

> Đoạn cấu hình web của Firebase **không phải bí mật** — Google thiết kế nó để công khai. Việc bảo vệ dữ liệu nằm ở `firestore.rules`, nên đưa file này lên GitHub là bình thường.

### 3. Đưa lên GitHub Pages

1. Tạo repository mới trên GitHub (VD `edu-assistant`), tải toàn bộ các file này lên (giữ nguyên thư mục `icons/`).
2. Repository → **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, thư mục `/ (root)` → Save.
3. Sau 1–2 phút app có ở địa chỉ `https://<tên-github>.github.io/edu-assistant/`.
4. Quay lại Firebase: **Authentication → Settings → Authorized domains → Add domain** → thêm `<tên-github>.github.io`.

### 4. Dùng thử

Mở đường dẫn → **Tạo tài khoản** → nhập ID và mật khẩu → bắt đầu tạo lớp. Trên điện thoại, dùng menu trình duyệt → **Thêm vào màn hình chính** để cài như app.

## Cập nhật phiên bản

Khi sửa code, mở `sw.js` và tăng `CACHE_VERSION` (VD `edu-assistant-v1.0.1`), đồng thời sửa `APP_VERSION` trong `app.js`. Máy người dùng sẽ tự lấy bản mới khi mở app có mạng và hiện thông báo "Đã có phiên bản mới".

## Chạy thử trên máy

Service worker không chạy khi mở file trực tiếp (`file://`). Hãy chạy một máy chủ tĩnh đơn giản:

```bash
python3 -m http.server 8080
# rồi mở http://localhost:8080
```

## Chuyển dữ liệu từ bản EduTrack đầy đủ

Trong EduTrack: **Trang chủ → Xuất toàn bộ dữ liệu** → được file `.json`. Trong EDU ASSISTANT: **Tài khoản & dữ liệu → Khôi phục từ file** → chọn file đó. Chỉ phần lớp, học sinh và buổi học được chuyển sang.

## Lưu ý

- Quên mật khẩu với ID không phải email thì không lấy lại qua thư được. Chủ dự án có thể đặt lại mật khẩu cho giáo viên trong **Firebase Console → Authentication → Users**.
- Gói miễn phí (Spark) của Firebase đủ cho vài chục giáo viên dùng hằng ngày.
- Nên **xuất file sao lưu** định kỳ, và không đưa file sao lưu (chứa tên học sinh) lên GitHub — `.gitignore` đã chặn sẵn tên file mặc định.

## Giấy phép

MIT — xem file `LICENSE`.
