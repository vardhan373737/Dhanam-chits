(async ()=>{
  try {
    const res = await fetch('http://localhost:5000/payment-reminderA.html');
    console.log('STATUS', res.status);
    const txt = await res.text();
    console.log('LENGTH', txt.length);
    const hasId = txt.includes('id="paidThisMonthCount"');
    console.log('HAS_PAID_ID', hasId);
    if (hasId) {
      const idx = txt.indexOf('id="paidThisMonthCount"');
      console.log('\n---- SNIPPET AROUND id=paidThisMonthCount ----\n');
      console.log(txt.slice(Math.max(0, idx-200), Math.min(txt.length, idx+200)));
      console.log('\n---- END SNIPPET ----\n');
    }
  } catch (e) {
    console.error('FETCH_ERROR', e);
    process.exit(1);
  }
})();
