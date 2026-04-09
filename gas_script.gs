function extractId(input) {
    if (!input) return "";
    var str = input.toString().trim();
    var match = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    match = str.match(/\/folders\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    return str;
}

function extractGid(input) {
    if (!input) return null;
    var str = input.toString().trim();
    var match = str.match(/[#&?]gid=([0-9]+)/);
    if (match) return match[1];
    return null;
}

function getSheetByUrl(url) {
    var sheetId = extractId(url);
    var gid = extractGid(url);
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    
    if (gid !== null) {
        var sheets = spreadsheet.getSheets();
        for (var i = 0; i < sheets.length; i++) {
            if (sheets[i].getSheetId().toString() === gid.toString()) {
                return sheets[i];
            }
        }
    }
    return spreadsheet.getSheets()[0];
}

function getTargetRow(sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 5) return 6;
    
    var values = sheet.getRange(6, 2, Math.max(1, lastRow - 5), 3).getValues();
    for (var i = 0; i < values.length; i++) {
        // Check if both Date (col B, index 0) and Category (col D, index 2) are empty
        if ((!values[i][0] || values[i][0] === "") && (!values[i][2] || values[i][2] === "")) {
            return i + 6;
        }
    }
    return lastRow + 1;
}

function doPost(e) {
    try {
        var data = JSON.parse(e.postData.contents);
        var action = data.action;

        if (action === 'add_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var folderId = extractId(data.folderId);
            var folder = DriveApp.getFolderById(folderId);

            var receiptUrl = "";
            var receiptUrls = [];
            if (data.receiptBase64s && data.receiptBase64s.length > 0) {
                for (var i = 0; i < data.receiptBase64s.length; i++) {
                    var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64s[i]), 'image/jpeg', 'Receipt_' + new Date().getTime() + '_' + i + '.jpg');
                    var file = folder.createFile(blob);
                    receiptUrls.push(file.getUrl());
                }
                receiptUrl = receiptUrls.join('\n');
            }

            var targetRow = getTargetRow(sheet);

            // B to N is 13 columns
            sheet.getRange(targetRow, 2, 1, 13).setValues([[
                data.date,       // B
                "",              // C
                data.category,   // D
                "",              // E
                data.amount,     // F
                "",              // G
                data.unit,       // H
                "",              // I
                data.payer,      // J
                "",              // K
                receiptUrl,      // L
                "",              // M
                data.notes       // N
            ]]);

            return ContentService.createTextOutput(JSON.stringify({ success: true, rowNumber: targetRow }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Invalid action' }))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}