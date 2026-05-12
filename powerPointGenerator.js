const PptxGenJS = require('pptxgenjs');

const generatePaymentReminderPptx = (reminders, outputPath) => {
  const prs = new PptxGenJS();
  prs.defineLayout({ name: 'LAYOUT1', width: 10, height: 7.5 });
  prs.defineLayout({ name: 'LAYOUT2', width: 13.333, height: 7.5 });

  // Ensure reminders is an array
  const remindersList = Array.isArray(reminders) ? reminders : [];
  const totalCount = remindersList.length;

  // Premium color scheme
  const colors = {
    primary: '0e8b9c',
    primaryDark: '0d6f85',
    primaryLight: '1ba3b3',
    accent: '0f9a5f',
    accentLight: '26b373',
    danger: 'b8304e',
    text: '102739',
    lightText: '496a81',
    lightBg: 'edf8ff',
    darkBg: '051f37',
    white: 'FFFFFF',
    gray1: 'f8fafb',
    gray2: 'e8f0f5',
    gray3: 'd0dde6'
  };

  // Premium Title slide with gradient effect
  const titleSlide = prs.addSlide();
  titleSlide.background = { color: colors.darkBg };
  
  // Add decorative shapes
  titleSlide.addShape(prs.ShapeType.ellipse, {
    x: -0.5,
    y: -0.5,
    w: 4,
    h: 4,
    fill: { color: colors.primary, transparency: 30 },
    line: { type: 'none' }
  });
  
  titleSlide.addShape(prs.ShapeType.ellipse, {
    x: 8,
    y: 5,
    w: 3,
    h: 3,
    fill: { color: colors.accent, transparency: 25 },
    line: { type: 'none' }
  });

  // Premium title
  titleSlide.addText('Payment Reminder Report', {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 1.2,
    fontSize: 54,
    bold: true,
    color: colors.white,
    align: 'center',
    fontFace: 'Calibri',
    shadow: {
      type: 'outer',
      angle: 45,
      blur: 8,
      offset: 3,
      opacity: 0.5,
      color: '000000'
    }
  });
  // Premium subtitle box
  titleSlide.addShape(prs.ShapeType.roundRect, {
    x: 2,
    y: 3.6,
    w: 6,
    h: 1,
    fill: { color: colors.primary },
    line: { color: colors.accent, width: 2 },
    rectRadius: 0.15
  });
  
  titleSlide.addText(`Total Reminders: ${totalCount}`, {
    x: 2,
    y: 3.7,
    w: 6,
    h: 0.8,
    fontSize: 28,
    bold: true,
    color: colors.white,
    align: 'center',
    valign: 'middle'
  });

  // Premium Summary slide
  if (remindersList && remindersList.length > 0) {
    const summarySlide = prs.addSlide();
    summarySlide.background = { color: colors.white };
    
    // Header bar
    summarySlide.addShape(prs.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 10,
      h: 1,
      fill: { color: colors.darkBg },
      line: { type: 'none' }
    });
    
    summarySlide.addText('Executive Summary', {
      x: 0.5,
      y: 0.2,
      w: 9,
      h: 0.6,
      fontSize: 36,
      bold: true,
      color: colors.white,
      fontFace: 'Calibri'
    });

    // Summary statistics boxes
    const stats = [
      { 
        label: 'Total Reminders', 
        value: totalCount,
        color: colors.primary,
        icon: '📊'
      },
      { 
        label: 'Generated', 
        value: new Date().toLocaleDateString('en-IN'),
        color: colors.accent,
        icon: '📅'
      },
      { 
        label: 'Total Amount', 
        value: formatTotalAmount(remindersList),
        color: colors.primaryDark,
        icon: '💰'
      }
    ];

    let xPos = 0.5;
    stats.forEach((stat, idx) => {
      summarySlide.addShape(prs.ShapeType.roundRect, {
        x: xPos,
        y: 1.5,
        w: 3,
        h: 2.8,
        fill: { color: colors.gray1 },
        line: { color: stat.color, width: 3 },
        rectRadius: 0.12
      });
      
      summarySlide.addText(stat.icon, {
        x: xPos,
        y: 1.7,
        w: 3,
        h: 0.5,
        fontSize: 32,
        align: 'center'
      });
      
      summarySlide.addText(stat.label, {
        x: xPos + 0.2,
        y: 2.3,
        w: 2.6,
        h: 0.4,
        fontSize: 11,
        bold: true,
        color: colors.text,
        align: 'center'
      });
      
      summarySlide.addText(String(stat.value), {
        x: xPos + 0.2,
        y: 2.8,
        w: 2.6,
        h: 0.8,
        fontSize: 16,
        bold: true,
        color: stat.color,
        align: 'center',
        valign: 'middle'
      });
      
      xPos += 3.15;
    });

    // Footer with design
    summarySlide.addShape(prs.ShapeType.rect, {
      x: 0,
      y: 6.8,
      w: 10,
      h: 0.7,
      fill: { color: colors.gray2 },
      line: { type: 'none' }
    });
    
    summarySlide.addText('Premium Payment Management Solution', {
      x: 0.5,
      y: 6.85,
      w: 9,
      h: 0.6,
      fontSize: 10,
      color: colors.primary,
      align: 'center',
      valign: 'middle',
      bold: true
    });
  }

  // Premium Details slides
  if (remindersList && remindersList.length > 0) {
    const remindersPerSlide = 8;
    for (let i = 0; i < remindersList.length; i += remindersPerSlide) {
      const slideReminders = remindersList.slice(i, i + remindersPerSlide);
      const slide = prs.addSlide();
      slide.background = { color: colors.white };

      const slideNumber = Math.floor(i / remindersPerSlide) + 1;
      
      // Premium header
      slide.addShape(prs.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 10,
        h: 0.8,
        fill: { color: colors.primary },
        line: { type: 'none' }
      });
      
      slide.addText(`Payment Reminders - Page ${slideNumber}`, {
        x: 0.5,
        y: 0.15,
        w: 9,
        h: 0.5,
        fontSize: 28,
        bold: true,
        color: colors.white,
        fontFace: 'Calibri'
      });

      // Table data
      const tableData = [
        [{
          text: 'User',
          options: { bold: true, fontSize: 11, color: colors.white, fill: colors.primary }
        }, {
          text: 'Amount',
          options: { bold: true, fontSize: 11, color: colors.white, fill: colors.primary }
        }, {
          text: 'Status',
          options: { bold: true, fontSize: 11, color: colors.white, fill: colors.primary }
        }, {
          text: 'Due Date',
          options: { bold: true, fontSize: 11, color: colors.white, fill: colors.primary }
        }]
      ];

      slideReminders.forEach((reminder, idx) => {
        const statusColor = getStatusColor(reminder.status, colors);
        tableData.push([
          {
            text: reminder.userName || 'N/A',
            options: { fontSize: 10, color: colors.text, fill: idx % 2 === 0 ? colors.gray1 : colors.white }
          },
          {
            text: `₹${reminder.amount || 0}`,
            options: { fontSize: 10, color: colors.text, fill: idx % 2 === 0 ? colors.gray1 : colors.white, bold: true }
          },
          {
            text: reminder.status || 'Pending',
            options: { 
              fontSize: 10, 
              color: statusColor,
              fill: idx % 2 === 0 ? colors.gray1 : colors.white,
              bold: true
            }
          },
          {
            text: reminder.dueDate ? new Date(reminder.dueDate).toLocaleDateString('en-IN') : 'N/A',
            options: { fontSize: 10, color: colors.text, fill: idx % 2 === 0 ? colors.gray1 : colors.white }
          }
        ]);
      });

      slide.addTable(tableData, {
        x: 0.5,
        y: 1.1,
        w: 9,
        h: 5.5,
        colW: [2.5, 2, 2, 2],
        border: { pt: 1, color: colors.gray3 }
      });

      // Page footer
      slide.addShape(prs.ShapeType.rect, {
        x: 0,
        y: 6.9,
        w: 10,
        h: 0.6,
        fill: { color: colors.gray2 },
        line: { type: 'none' }
      });
      
      slide.addText(`Page ${slideNumber} of ${Math.ceil(remindersList.length / remindersPerSlide)}`, {
        x: 0.5,
        y: 6.95,
        w: 9,
        h: 0.5,
        fontSize: 9,
        color: colors.lightText,
        align: 'right'
      });
    }
  }

  // Premium Footer slide
  const footerSlide = prs.addSlide();
  
  // Gradient effect with shapes
  footerSlide.addShape(prs.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 10,
    h: 7.5,
    fill: { color: colors.darkBg },
    line: { type: 'none' }
  });
  
  footerSlide.addShape(prs.ShapeType.ellipse, {
    x: 1,
    y: -1,
    w: 5,
    h: 5,
    fill: { color: colors.primary, transparency: 20 },
    line: { type: 'none' }
  });
  
  footerSlide.addShape(prs.ShapeType.ellipse, {
    x: 6,
    y: 4,
    w: 4,
    h: 4,
    fill: { color: colors.accent, transparency: 20 },
    line: { type: 'none' }
  });
  
  footerSlide.addText('Thank You', {
    x: 0.5,
    y: 2.5,
    w: 9,
    h: 1,
    fontSize: 48,
    bold: true,
    color: colors.white,
    align: 'center',
    fontFace: 'Calibri'
  });

  footerSlide.addText('Payment Reminder Report Completed', {
    x: 0.5,
    y: 3.7,
    w: 9,
    h: 0.6,
    fontSize: 18,
    color: colors.accent,
    align: 'center'
  });

  footerSlide.addText('Dhanam Chits Dashboard', {
    x: 0.5,
    y: 5.5,
    w: 9,
    h: 0.5,
    fontSize: 12,
    color: colors.gray2,
    align: 'center',
    italic: true
  });
  
  footerSlide.addText(`Report Generated: ${new Date().toLocaleString('en-IN')}`, {
    x: 0.5,
    y: 6.2,
    w: 9,
    h: 0.4,
    fontSize: 9,
    color: colors.gray3,
    align: 'center'
  });

  // Save to file
  return prs.writeFile({ fileName: outputPath });
};

// Helper function to format total amount
const formatTotalAmount = (reminders) => {
  if (!reminders || reminders.length === 0) return '₹0';
  const total = reminders.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  return `₹${total.toLocaleString('en-IN')}`;
};

// Helper function to get status color
const getStatusColor = (status, colors) => {
  if (!status) return colors.lightText;
  const normalizedStatus = String(status).toLowerCase();
  if (normalizedStatus.includes('paid') || normalizedStatus.includes('completed')) {
    return colors.accent;
  }
  if (normalizedStatus.includes('overdue') || normalizedStatus.includes('pending')) {
    return colors.danger;
  }
  return colors.primary;
};

module.exports = { generatePaymentReminderPptx };
