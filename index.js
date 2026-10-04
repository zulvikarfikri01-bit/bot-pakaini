import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";

// ===================================================
// KONFIGURASI BOT & ADMIN
// ===================================================
const BOT_NAME = "PAKAINI STORE";
const ADMIN_CONTACT = "6285143253217";
const ADMIN_JID = `${ADMIN_CONTACT}@s.whatsapp.net`;
const EWALLET_NUMBER = "085143253217";
const ACCOUNT_NAME = "KH***S FEB*******H FAD*****AH";

// Nomor WhatsApp bot untuk login via Pairing Code (format internasional tanpa tanda +, contoh: 6285143253217)
const BOT_PHONE_NUMBER = "6285143253217"; 

// ID Grup Notifikasi Admin
let NOTIF_GROUP_ID = "120363430688539207@g.us"; 

// Penyimpanan pesanan sementara per user
const activeOrders = new Map();
const lastOrders = new Map();

let isReconnecting = false;
let currentSock = null;

// Helper untuk mencari file QRIS (.jpg / .jpeg / .png)
function getQrisImagePath() {
  const candidates = [
    path.join(process.cwd(), "qris.jpg"),
    path.join(process.cwd(), "qris.jpeg"),
    path.join(process.cwd(), "qris.png")
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function startBot() {
  if (isReconnecting) return;

  // Tutup koneksi lama jika masih ada sebelum memulai yang baru
  if (currentSock) {
    try {
      currentSock.ev.removeAllListeners();
      currentSock.end(undefined);
    } catch (e) {}
    currentSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState("session_auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.windows("Desktop"),
    syncFullHistory: false
  });

  currentSock = sock;

  // JIKA BELUM LOGIN, GUNAKAN PAIRING CODE BUKAN QR CODE
  if (BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        console.log(`\n=========================================`);
        console.log(`🔑 KODE PAIRING WHATSAPP ANDA: ${code}`);
        console.log(`=========================================\n`);
      } catch (err) {
        console.error("Gagal meminta kode pairing:", err);
      }
    }, 4000); // Beri jeda 4 detik agar koneksi siap
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Tampilkan QR code jika pairing code tidak disetel
    if (qr && !BOT_PHONE_NUMBER) {
      console.log("\n[SCAN QR CODE INI MENGGUNAKAN WHATSAPP]\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isReplaced = statusCode === DisconnectReason.connectionReplaced;

      console.log(`Koneksi terputus (Status: ${statusCode}).`);

      sock.ev.removeAllListeners();

      if (isReplaced) {
        console.log("⚠️ Sesi digantikan oleh perangkat/proses lain. Tidak menyambung ulang otomatis untuk menghindari konflik.");
        return;
      }

      if (isLoggedOut) {
        console.log("Sesi telah keluar/expired. Menghapus session lama untuk scan QR baru...");
        try {
          fs.rmSync("session_auth", { recursive: true, force: true });
        } catch (e) {}
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 2000);
      } else {
        console.log("Mencoba menyambung kembali dalam 3 detik...");
        isReconnecting = true;
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 3000);
      }
    } else if (connection === "open") {
      isReconnecting = false;
      console.log(`\n==================================================`);
      console.log(`✅ BOT ${BOT_NAME} BERHASIL ONLINE & SIAP DIGUNAKAN!`);
      console.log(`==================================================`);

      // OTOMATIS AMBIL SEMUA DAFTAR GRUP & ID-NYA KE TERMINAL
      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log("\n📋 DAFTAR GRUP WHATSAPP ANDA:");
        console.log("--------------------------------------------------");
        for (const id in groups) {
          console.log(`• Nama Grup : "${groups[id].subject}"`);
          console.log(`  ID Grup   : ${id}`);
          console.log("--------------------------------------------------");

          // Otomatis pasang jika menemukan grup yang mengandung kata "notifikasi" atau "nontifikasi"
          const subj = groups[id].subject.toLowerCase();
          if (subj.includes("notifikasi") || subj.includes("nontifikasi")) {
            NOTIF_GROUP_ID = id;
            console.log(`🎯 [TERDETEKSI OTOMATIS] Target Notifikasi diarahkan ke: "${groups[id].subject}" (${id})\n`);
          }
        }
      } catch (err) {
        console.error("Gagal mengambil daftar grup:", err);
      }
    }
  });

  // Fungsi pengiriman info bayar
  async function kirimPembayaran(toJid, quotedMessage, teksTambahan = "") {
    const textBayar = 
`${teksTambahan}💳 *METODE PEMBAYARAN RESMI ${BOT_NAME}*

Silakan lakukan pembayaran ke salah satu opsi di bawah ini:

• *DANA:*
  Nomor: \`${EWALLET_NUMBER}\`
  A/N: *${ACCOUNT_NAME}*

• *GoPay:*
  Nomor: \`${EWALLET_NUMBER}\`
  A/N: *${ACCOUNT_NAME}*

⚠️ *Catatan:* Setelah transfer berhasil, harap kirimkan **bukti transfer ke grup** agar pesanan langsung diproses!`;

    const qrisPath = getQrisImagePath();

    if (qrisPath) {
      try {
        const imageBuffer = await fs.promises.readFile(qrisPath);
        await sock.sendMessage(toJid, {
          image: imageBuffer,
          caption: textBayar
        }, { quoted: quotedMessage });
      } catch (err) {
        console.error("Gagal mengirim gambar QRIS:", err);
        await sock.sendMessage(toJid, { text: textBayar }, { quoted: quotedMessage });
      }
    } else {
      await sock.sendMessage(toJid, { text: textBayar }, { quoted: quotedMessage });
    }
  }

  // Handler Pesan
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    const sender = msg.key.participant || from;
    const rawNumber = sender.replace(/[^0-9]/g, "");

    const isImage = Boolean(msg.message.imageMessage);
    const rawBody = 
      msg.message.conversation || 
      msg.message.extendedTextMessage?.text || 
      msg.message.imageMessage?.caption || 
      msg.message.videoMessage?.caption || 
      "";

    const command = rawBody.trim().toLowerCase();

    // ==========================================
    // 1. PERINTAH ADMIN (DONE / PROSES OTOMATIS BEDA SOSMED & CAPCUT)
    // ==========================================
    if (
      command.startsWith("done") || 
      command.startsWith(".done") || 
      command.startsWith("!done") ||
      command.startsWith("proses") ||
      command.startsWith(".proses")
    ) {
      const contextInfo = msg.message.extendedTextMessage?.contextInfo;
      const targetParticipant = contextInfo?.participant;
      const targetTag = targetParticipant ? `@${targetParticipant.replace(/[^0-9]/g, "")}` : "Kak";

      // Catatan manual dari admin jika ada (misal: "done capcut 1 bl")
      const customNote = rawBody.replace(/^(done|\.done|!done|proses|\.proses)/i, "").trim();

      // Cek riwayat order pembeli yang di-reply
      const previousOrder = targetParticipant 
        ? (activeOrders.get(targetParticipant) || lastOrders.get(targetParticipant) || lastOrders.get(targetParticipant.replace(/[^0-9]/g, "")))
        : null;
      const rawOrderText = previousOrder ? previousOrder.text.toLowerCase() : "";
      const noteLower = customNote.toLowerCase();

      // Deteksi apakah ini pesanan CapCut
      const isCapcut = noteLower.includes("capcut") || rawOrderText.includes("capcut");

      // JIKA CAPCUT -> BALAS FORMAT NOTA SELESAI
      if (isCapcut) {
        const now = new Date();
        const jamStr = now.toLocaleTimeString("id-ID", { 
          timeZone: "Asia/Jakarta", 
          hour: "2-digit", 
          minute: "2-digit", 
          second: "2-digit" 
        }).replace(/\./g, ":") + " WIB";

        const tglStr = now.toLocaleDateString("id-ID", { 
          timeZone: "Asia/Jakarta", 
          day: "numeric", 
          month: "long", 
          year: "numeric" 
        });

        let groupName = "PAKAINI STORE";
        if (isGroup) {
          try {
            const groupMeta = await sock.groupMetadata(from);
            groupName = groupMeta.subject || groupName;
          } catch (e) {
            groupName = "PAKAINI STORE";
          }
        }

        const catatanFinal = customNote || (previousOrder ? previousOrder.layanan : "CapCut Premium Privat");

        const textDoneCapcut = 
`*TRANSAKSI BERHASIL* 「✅」


⏰ Jam      : ${jamStr}
📅 Tanggal  : ${tglStr}
📁 Grup     : ${groupName}
📝 Catatan  : ${catatanFinal}


${targetTag} _Terima kasih sudah order!_`;

        await sock.sendMessage(from, {
          text: textDoneCapcut,
          mentions: targetParticipant ? [targetParticipant] : []
        }, { quoted: msg });

        return;
      }

      // JIKA FOLLOWERS / SOSMED -> BALAS FORMAT ESTIMASI PENGERJAAN
      const textProsesSosmed = 
`✅ *PAYMENT ACCEPTED — ORDER ON PROGRESS!*
Pembayaran sukses kami terima. Pesanan ${targetTag} sedang langsung dikerjakan oleh tim teknis *${BOT_NAME}*.

⏱️️ *Estimasi:* Mulai naik dalam *4 jam s/d maksimal 48 jam* tergantung kepadatan server. Tenang kak, sistem kami buat bertahap biar interaksi akun kamu tetap aman dan alami!

⚠️ *Catatan Penting:*
• *Dilarang menumpuk order* ke target yang sama sebelum proses ini selesai.
• *Jangan ubah username / privat akun*.

Mohon bersabar dan tunggu proses pengerjaan sampai selesai. Jangan mengirim chat spam atau menanyakan berulang kali karena setiap pesanan diproses otomatis sesuai nomor antrean sistem. Terima kasih atas pengertian dan kerja samanya! 🚀`;

      await sock.sendMessage(from, {
        text: textProsesSosmed,
        mentions: targetParticipant ? [targetParticipant] : []
      }, { quoted: msg });

      return;
    }

    if (msg.key.fromMe) return;

    // Log ke terminal untuk monitoring chat masuk
    if (command || isImage) {
      console.log(`[Pesan Masuk] Dari: +${rawNumber} (${from}) | Tipe: ${isImage ? "Gambar" : "Teks"} | Konten: "${command}"`);
    }

    // ==========================================
    // 2. OTOMATIS: BUKTI TRANSFER PEMBELI
    // ==========================================
    if (isImage) {
      const userOrder = activeOrders.get(sender) || activeOrders.get(rawNumber);

      if (userOrder) {
        // Balas di grup transaksi tempat pembeli kirim bukti
        const textBuktiGrup = 
`✅ *BUKTI PEMBAYARAN DITERIMA!*

Terima kasih @${rawNumber}, bukti pembayaran pesanan Anda berhasil kami terima dan sedang diverifikasi oleh admin.

Mohon ditunggu ya! Jika ada kendala, hubungi wa.me/${ADMIN_CONTACT}`;

        await sock.sendMessage(from, { 
          text: textBuktiGrup,
          mentions: [sender]
        }, { quoted: msg });

        const waLink = rawNumber.length >= 10 && !rawNumber.startsWith("12") 
          ? `https://wa.me/${rawNumber}` 
          : `_(Akun privat/LID)_`;

        try {
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
          );

          const pesanKeAdmin = 
`🚨 *ORDER BARU MASUK (SUDAH BAYAR)* 🚨
----------------------------------------
👤 *Pengirim:* +${rawNumber}
💬 *Chat:* ${waLink}
⏰ *Waktu Bayar:* ${new Date().toLocaleTimeString("id-ID")} WIB

📋 *DETAIL PESANAN:*
${userOrder.text}
----------------------------------------
👉 *Tindakan Admin:*
1. Cek mutasi masuk di DANA / GoPay / Bank.
2. Salin target di atas ke panel server.
3. Reply foto bukti di grup dengan ketik *done*`;

          // Kirim bukti transfer dan rincian ke Grup Notifikasi Admin / Japri Admin
          const targetKirim = NOTIF_GROUP_ID || ADMIN_JID;
          await sock.sendMessage(targetKirim, {
            image: buffer,
            caption: pesanKeAdmin
          });

          activeOrders.delete(sender);
          activeOrders.delete(rawNumber);
          console.log(`[NOTIFIKASI] Sukses mengirim bukti bayar ke target notifikasi (${targetKirim}).`);
        } catch (err) {
          console.error("Gagal mengirim notifikasi bayar:", err);
        }

        return;
      }
    }

    // ==========================================
    // 3. DETEKSI FORMAT PEMESANAN OTOMATIS
    // ==========================================
    const bodyLower = rawBody.toLowerCase();
    if (bodyLower.includes("layanan:") && (bodyLower.includes("target:") || bodyLower.includes("jumlah:"))) {
      // Ambil nama layanan untuk riwayat
      const matchLayanan = rawBody.match(/layanan\s*:\s*([^\n\r]+)/i);
      const namaLayanan = matchLayanan ? matchLayanan[1].trim() : "Layanan Sosmed";

      const orderData = {
        text: rawBody.trim(),
        layanan: namaLayanan,
        time: new Date().toLocaleTimeString("id-ID")
      };

      activeOrders.set(sender, orderData);
      activeOrders.set(rawNumber, orderData);
      lastOrders.set(sender, orderData);
      lastOrders.set(rawNumber, orderData);

      console.log(`[Order Masuk] Format terisi dari +${rawNumber}. Mengirim konfirmasi & pembayaran...`);

      const headerKonfirmasi = 
`✅ *PESANAN DITERIMA!*
Halo @${rawNumber}, format pemesanan Anda sudah tercatat di sistem kami.
Silakan selesaikan pembayaran berikut:

`;
      await kirimPembayaran(from, msg, headerKonfirmasi);
      return;
    }

    // ==========================================
    // 4. MENU & PRICELIST
    // ==========================================
    if (command === "menu" || command === ".menu" || command === "!menu") {
      const textMenu = 
`⚡ *SELAMAT DATANG DI ${BOT_NAME}* ⚡
Pusat kebutuhan sosial media & akun premium terpercaya!

*Daftar Perintah:*
👉 *list* : Cek seluruh daftar harga / pricelist lengkap
👉 *capcut* : Cek pricelist & info CapCut Pro
👉 *order* : Format pemesanan layanan
👉 *bayar* : Info DANA, GoPay & Barcode QRIS
👉 *admin* : Kontak admin langsung

_Ketik salah satu kata perintah di atas untuk melanjutkan._`;
      await sock.sendMessage(from, { text: textMenu }, { quoted: msg });
    }

    // ==========================================
    // PERINTAH KHUSUS CAPCUT (HARGA TERBARU)
    // ==========================================
    else if (
      command === "capcut" || 
      command === ".capcut" || 
      command === "!capcut"
    ) {
      const textCapcut = 
`🎬 *PRICELIST CAPCUT PRO PRIVAT — ${BOT_NAME}* 🎬

Nikmati fitur pro tanpa watermark, ekspor 4K/60fps, transisi & filter premium! Akun disiapkan langsung oleh admin (tinggal login & pakai).

*Pilihan Paket:*
• *CapCut 7 Hari*   : Rp10.000
• *CapCut 1 Bulan*  : Rp35.000
• *CapCut 1 Tahun*  : Rp400.000

✨ *Keunggulan & Sistem Akun:*
✅ Akun Privat (bukan sharing ramai-ramai)
✅ Sistem siap pakai (Email & Password akun pro diberikan oleh admin setelah bayar)
✅ Bergaransi penuh sesuai durasi

_Untuk memesan, silakan ketik *order*_`;
      await sock.sendMessage(from, { text: textCapcut }, { quoted: msg });
    }

    else if (
      command === "list" || 
      command === ".list" || 
      command === "!list" || 
      command === "harga" || 
      command === ".harga" || 
      command === "price"
    ) {
      const textPrice = 
`📋 *PRICELIST LAYANAN ${BOT_NAME}* 📋

━━━━━━━━━━━━━━━━━━━━━
📸 *INSTAGRAM FOLLOWERS & LIKES*
━━━━━━━━━━━━━━━━━━━━━
*Followers Indo (Garansi 30H)*
• 300 Folls : Rp35.000
• 500 Folls : Rp45.000
• 1.000 Folls : Rp80.000
• 5.000 Folls : Rp250.000

*Followers Bule (No Garansi)*
• 100 Folls : Rp5.000
• 300 Folls : Rp12.000
• 500 Folls : Rp20.000
• 1.000 Folls : Rp35.000

*Likes Asli*
• 300 Likes : Rp20.000
• 500 Likes : Rp35.000
• 1.000 Likes : Rp60.000
• 5.000 Likes : Rp250.000

*Likes Murah*
• 300 Likes : Rp7.000
• 500 Likes : Rp10.000
• 1.000 Likes : Rp15.000
• 5.000 Likes : Rp30.000

*Views Murah*
• 5.000 Views : Rp6.000
• 10.000 Views : Rp8.000
• 15.000 Views : Rp10.000
• 25.000 Views : Rp15.000
• 50.000 Views : Rp20.000

━━━━━━━━━━━━━━━━━━━━━
🎵 *TIKTOK SERVICES*
━━━━━━━━━━━━━━━━━━━━━
*Followers Indo (Garansi 30H)*
• 300 Folls : Rp20.000
• 500 Folls : Rp80.000
• 700 Folls : Rp120.000
• 1.000 Folls : Rp150.000

*Followers Bule (Garansi 7H)*
• 300 Folls : Rp20.000
• 500 Folls : Rp27.000
• 700 Folls : Rp33.000
• 1.000 Folls : Rp38.000

*Likes Murah*
• 200 Likes : Rp5.000
• 500 Likes : Rp10.000
• 1.000 Likes : Rp15.000
• 5.000 Likes : Rp30.000

*Views Murah*
• 5.000 Views : Rp7.000
• 10.000 Views : Rp9.000
• 30.000 Views : Rp13.000
• 50.000 Views : Rp18.000
• 70.000 Views : Rp25.000

*Paket FYP (Likes + Views)*
• 200 Like + 5k Views : Rp10.000
• 500 Like + 10k Views : Rp20.000
• 1.000 Like + 15k Views : Rp25.000
• 1.000 Like + 20k Views : Rp30.000

━━━━━━━━━━━━━━━━━━━━━
▶️ *YOUTUBE SERVICES*
━━━━━━━━━━━━━━━━━━━━━
*Subscribe Asli (Garansi 30H)*
• 100 Subs : Rp75.000
• 200 Subs : Rp150.000
• 300 Subs : Rp215.000
• 400 Subs : Rp285.000
• 500 Subs : Rp350.000
• 700 Subs : Rp500.000
• 900 Subs : Rp620.000
• 1.000 Subs : Rp650.000

*Subscribe (No Garansi / No Complain)*
• 100 Subs : Rp20.000
• 200 Subs : Rp35.000
• 300 Subs : Rp55.000
• 400 Subs : Rp75.000
• 500 Subs : Rp95.000
• 700 Subs : Rp120.000
• 900 Subs : Rp150.000
• 1.000 Subs : Rp180.000

*Views YouTube*
• 100 Views : Rp6.000
• 200 Views : Rp8.000
• 300 Views : Rp10.000
• 400 Views : Rp12.000
• 500 Views : Rp14.000
• 600 Views : Rp16.000

━━━━━━━━━━━━━━━━━━━━━
🛍️ *SHOPEE FOLLOWERS INDO*
━━━━━━━━━━━━━━━━━━━━━
• 100 Folls : Rp15.000
• 200 Folls : Rp20.000
• 300 Folls : Rp25.000
• 400 Folls : Rp30.000
• 500 Folls : Rp35.000

━━━━━━━━━━━━━━━━━━━━━
🎬 *APLIKASI PREMIUM*
━━━━━━━━━━━━━━━━━━━━━
*CapCut Premium Privat (Full Garansi)*
• CapCut 7 Hari  : Rp10.000
• CapCut 1 Bulan : Rp35.000
• CapCut 1 Tahun : Rp400.000
_(Ketik *capcut* untuk info rinciannya)_

_Untuk memesan, silakan ketik *order*_`;
      await sock.sendMessage(from, { text: textPrice }, { quoted: msg });
    }

    // ==========================================
    // PERINTAH ORDER (KEMBALI KE FORMAT RESMI)
    // ==========================================
    else if (
      command === "order" || 
      command === ".order" || 
      command === "!order"
    ) {
      const textOrder = 
`📝 *FORMAT PEMESANAN ${BOT_NAME}*

Silakan salin format di bawah ini, lengkapi data, lalu kirim kembali:

*Form Pemesanan:*
• Layanan: IG Followers Indo
• Jumlah: 500
• Target: https://www.instagram.com/username
• Pembayaran: QRIS

⚠️ *Perhatian:* 
• Akun target *DILARANG DIPRIVAT* selama proses pesanan berjalan!
• Untuk order *CapCut*, bagian target cukup diisi tanda strip *(-) / Akun Baru*.
👉 Ketik *pay* untuk melihat rincian nomor pembayaran & QRIS.`;

      await sock.sendMessage(from, { text: textOrder }, { quoted: msg });
    }

    // ==========================================
    // TAMBAHAN PERINTAH BAYAR / PAY
    // ==========================================
    else if (
      command === "bayar" || 
      command === ".bayar" || 
      command === "!bayar" || 
      command === "pay" || 
      command === ".pay" || 
      command === "!pay"
    ) {
      await kirimPembayaran(from, msg);
    }

    else if (command === "admin" || command === ".admin" || command === "!admin") {
      const textAdmin = 
`👤 *BANTUAN ADMIN ${BOT_NAME}*
Jika ada kendala pembayaran atau order belum masuk, hubungi admin:
👉 wa.me/${ADMIN_CONTACT}`;
      await sock.sendMessage(from, { text: textAdmin }, { quoted: msg });
    }
  });
}

startBot();
