// test-concurrency.js
const TOTAL_REQUESTS = 20; // จำนวนคนที่พยายามกดซื้อพร้อมกัน
const SKU_TO_TEST = 'IPHONE-16-PRO';
const QUANTITY_PER_REQUEST = 1;

async function sendOrder(index) {
    try {
        const response = await fetch('http://localhost:3000/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sku: SKU_TO_TEST,
                quantity: QUANTITY_PER_REQUEST
            })
        });
        const result = await response.json();
        console.log(`[Request #${index}] Status: ${response.status}, Success: ${result.success}, Message: ${result.message || 'Order Placed'}`);
    } catch (err) {
        console.error(`[Request #${index}] Error:`, err.message);
    }
}

async function runTest() {
    console.log(`🚀 เริ่มจำลองยิงคำสั่งซื้อพร้อมกัน ${TOTAL_REQUESTS} Requests...`);

    // สร้าง Promise array เพื่อยิง Request ออกไปพร้อมๆ กัน (Concurrent)
    const promises = [];
    for (let i = 1; i <= TOTAL_REQUESTS; i++) {
        promises.push(sendOrder(i));
    }

    await Promise.all(promises);
    console.log(`✨ ทดสอบ Concurrency เสร็จสิ้น! ลองเช็คสต็อคคงเหลือใน Redis และประวัติใน PostgreSQL ดูครับ`);
}

runTest();