import axios from 'axios';

export async function sendCostProposalToGAS(
    gasUrl: string,
    sheetUrl: string,
    folderUrl: string,
    costDetails: any,
    receiptBase64s: string[]
) {
    try {
        const payload = {
            action: 'add_expense',
            sheetId: sheetUrl,
            folderId: folderUrl,
            date: costDetails.cost_date,
            category: costDetails.cost_category,
            amount: costDetails.cost_amount_parsed,
            unit: costDetails.cost_unit,
            payer: costDetails.cost_payer,
            notes: costDetails.cost_notes || '',
            receiptBase64s: receiptBase64s
        };

        const response = await axios.post(gasUrl, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error sending data to GAS:', error);
        throw error;
    }
}
