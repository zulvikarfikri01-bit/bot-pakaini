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

// ID Grup Notifikasi Admin
let NOTIF_GROUP_ID = "120363430688539207@g.us"; 

// Penyimpanan pesanan sementara per user
const activeOrders = new Map();

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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
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
    // 1. PERINTAH KHUSUS ADMIN (DONE / PROSES)
    // ==========================================
    if (
      command === "done" || 
      command === ".done" || 
      command === "!done" || 
      command === "proses" || 
      command === ".proses"
    ) {
      const contextInfo = msg.message.extendedTextMessage?.contextInfo;
      const targetParticipant = contextInfo?.participant;
      const targetTag = targetParticipant ? `@${targetParticipant.replace(/[^0-9]/g, "")} ` : "";

      const textProses = 
`✅ *PAYMENT ACCEPTED — ORDER ON PROGRESS!*
Pembayaran sukses kami terima. Pesanan ${targetTag}sedang langsung dikerjakan oleh tim teknis *${BOT_NAME}*.

⏱️ *Estimasi:* Mulai naik dalam *4 jam s/d maksimal 48 jam* tergantung kepadatan server. Tenang kak, sistem kami buat bertahap biar interaksi akun kamu tetap aman dan alami!

⚠️ *Catatan Penting:*
• *Dilarang menumpuk order* ke target yang sama sebelum proses ini selesai.
• *Jangan ubah username / privat akun*.

Mohon bersabar dan tunggu proses pengerjaan sampai selesai. Jangan mengirim chat spam atau menanyakan berulang kali karena setiap pesanan diproses otomatis sesuai nomor antrean sistem. Terima kasih atas pengertian dan kerja samanya! 🚀`;

      await sock.sendMessage(from, {
        text: textProses,
        mentions: targetParticipant ? [targetParticipant] : []
      }, { quoted: msg });
      
      console.log(`[ADMIN] Perintah ${command} berhasil dieksekusi di ${from}`);
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
    // 3. DETEKSI FORMAT PEMESANAN
    // ==========================================
    const matchTarget = rawBody.match(/target\s*:\s*([^\n\r]+)/i);
    const targetValue = matchTarget ? matchTarget[1].replace(/⚠️️?.*/g, "").trim() : "";
    const isTargetFilled = targetValue.length > 2 && !targetValue.startsWith("(") && targetValue.toLowerCase() !== "username";
    const bodyLower = rawBody.toLowerCase();

    if (bodyLower.includes("layanan:") && bodyLower.includes("target:") && isTargetFilled) {
      const orderData = {
        text: rawBody.trim(),
        time: new Date().toLocaleTimeString("id-ID")
      };

      activeOrders.set(sender, orderData);
      activeOrders.set(rawNumber, orderData);

      console.log(`[Order Masuk] Format terisi dari +${rawNumber}. Mengirim konfirmasi & pembayaran...`);

      const headerKonfirmasi = 
`✅ *PESANAN DITERIMA!*
Halo @${rawNumber}, format pesanan Anda sudah tercatat di sistem kami.
Silakan selesaikan pembayaran:

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
Pusat kebutuhan sosial media cepat, aman & terpercaya!

*Daftar Perintah:*
👉 *list* : Cek seluruh daftar harga / pricelist
👉 *order* : Format pemesanan layanan
👉 *bayar* : Info DANA, GoPay & Barcode QRIS
👉 *admin* : Kontak admin langsung

_Ketik salah satu kata perintah di atas untuk melanjutkan._`;
      await sock.sendMessage(from, { text: textMenu }, { quoted: msg });
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

*INSTAGRAM FOLLOWERS INDO*
• 300 Folls : Rp31.000
• 500 Folls : Rp39.000
• 1.000 Folls : Rp68.000

*INSTAGRAM FOLLOWERS BULE*
• 100 Folls : Rp6.000
• 300 Folls : Rp9.000
• 500 Folls : Rp12.000
• 1.000 Folls : Rp18.000

*INSTAGRAM LIKES & VIEWS*
• 300 - 5.000 Likes : Rp8.000 - Rp31.000
• 5.000 - 50.000 Views : Rp7.000 - Rp21.000

*TIKTOK FOLLOWERS*
• 300 Folls : Rp21.000
• 500 Folls : Rp28.000
• 700 Folls : Rp34.000
• 1.000 Folls : Rp39.000

*TIKTOK LIKES / VIEWS / PAKET FYP*
• 200 - 5.000 Likes : Rp6.000 - Rp31.000
• 5.000 - 70.000 Views : Rp8.000 - Rp26.000
• Paket FYP (Likes+Views) : Mulai Rp9.000

*YOUTUBE SUBS & VIEWS*
• 100 - 1.000 Subs : Rp9.000 - Rp35.000
• 100 - 600 Views : Rp7.000 - Rp17.000

*SHOPEE & TELEGRAM*
• Shopee 100-500 Folls : Rp11.000 - Rp31.000
• Telegram Member Indo : Mulai Rp16.000
• Telegram Member Bule : Mulai Rp9.000
• Telegram Views : Mulai Rp7.000

_Untuk pesan, silakan ketik *order*_`;
      await sock.sendMessage(from, { text: textPrice }, { quoted: msg });
    }

    else if (command === "order" || command === ".order" || command === "!order") {
      const textOrder = 
`📝 *FORMAT PEMESANAN ${BOT_NAME}*

Silakan salin format di bawah ini, lengkapi data, lalu kirim kembali:

*Form Pemesanan:*
• Layanan: 
• Jumlah: 
• Target: 
• Pembayaran: 

⚠️ *Perhatian:* Akun target *DILARANG DIPRIVAT* selama proses pesanan berjalan!`;
      await sock.sendMessage(from, { text: textOrder }, { quoted: msg });
    }

    else if (command === "bayar" || command === ".bayar" || command === "!bayar") {
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
