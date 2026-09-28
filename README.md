# SPX Tracker — Theo Dõi Sản Lượng & Điểm

> PWA theo dõi sản lượng **Giao / Lấy / Hoàn** theo 8 dải khối lượng, tự động tra cứu điểm theo bảng tier SPX, hỗ trợ OCR ảnh chụp màn hình (quét nhiều ảnh cùng lúc), có theme sáng/tối, và hoạt động offline.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![PWA](https://img.shields.io/badge/PWA-ready-purple)

---

## ✨ Tính năng

### 📊 Tính điểm & theo dõi
- ✅ Tra cứu điểm theo **8 dải khối lượng** cho 3 loại đơn: **Giao / Lấy / Hoàn**
- ✅ Tổng điểm có **thưởng hạng**: Chuẩn / Đồng / Bạc / Vàng / Bạch Kim / Kim Cương (+0% → +26%)
- ✅ Phân bổ tỷ lệ % giữa 3 loại đơn
- ✅ Gợi ý **mốc tiếp theo cần đạt** — biết chính xác cần thêm bao nhiêu đơn
- ✅ Lọc theo kỳ: **Tất cả / Tháng này / Tháng trước / Hôm nay**
- ✅ Lưu lịch sử theo từng ngày, sửa/xóa từng bản ghi

### 📷 OCR ảnh chụp màn hình
- ✅ Quét **1 ảnh** → tự mở form nhập với dữ liệu điền sẵn
- ✅ Quét **nhiều ảnh cùng lúc** (batch) → xem trước, chọn nhập từng ảnh hoặc lưu tất cả
- ✅ Nút **"Quét thêm"** để bổ sung vào batch đang mở
- ✅ **Tự động phát hiện tab** (Giao/Lấy/Hoàn) qua vạch cam
- ✅ **6-strip OCR** — độ chính xác cao hơn OCR 1 lần
- ✅ **Confidence highlighting** — viền xanh/vàng/đỏ + badge % cho từng dải cần kiểm tra
- ✅ **Cache theo SHA-1** — quét lại cùng ảnh = tức thì
- ✅ Tối ưu cho **screenshot** (bỏ status bar, downscale 1440px, nhanh gấp 2×)

### 🎨 Giao diện
- ✅ Theme **Sáng / Tối** (tự động lưu)
- ✅ **Glassmorphism** — nền gradient + blur đẹp mắt
- ✅ **Mobile-first** — thiết kế cho điện thoại
- ✅ **PWA** — cài được lên home screen, chạy offline

### 💾 Dữ liệu
- ✅ Lưu **localStorage** — không cần server
- ✅ **Backup vault tự động** — khôi phục khi cần
- ✅ **Export / Import JSON** — sao lưu và di chuyển dữ liệu
- ✅ **Chép / Dán JSON** — chia sẻ nhanh qua chat

---

## 🚀 Deploy lên GitHub Pages

### Bước 1: Clone hoặc tạo repo mới

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<username>/spx-tracker.git
git push -u origin main