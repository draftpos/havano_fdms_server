import sys
import os

# Add Havano POS path to sys.path so we test actual POS service imports
sys.path.insert(0, r"C:\Users\user\Desktop\Havano_POS_2026-main")

from services.zimra_api_service import get_zimra_service
from models.fiscal_settings import FiscalSettings

def main():
    service = get_zimra_service()
    
    settings = FiscalSettings(
        enabled=True,
        provider="havano_zimra",
        base_url="http://localhost:3000",
        api_key="zf_live_key_admin_test_123",
        api_secret="zf_live_sec_admin_test_456",
        device_sn="MYPOS01",
    )

    print("==================================================")
    print("TESTING HAVANO FISCAL DAY OPERATIONS END-TO-END")
    print("==================================================")

    # 1. Check Status
    print("\n[Step 1] Checking initial device status...")
    st_res = service.get_device_status(settings)
    print("Success:", st_res.is_success)
    print("Data:", st_res.data)
    print("Error:", st_res.error)
    assert st_res.is_success, f"Failed status check: {st_res.error}"

    # 2. Open Fiscal Day
    print("\n[Step 2] Opening Fiscal Day...")
    open_res = service.open_fiscal_day(settings)
    print("Success:", open_res.is_success)
    print("Data:", open_res.data)
    print("Error:", open_res.error)
    assert open_res.is_success, f"Failed open day: {open_res.error}"

    # 3. Check Status after open
    print("\n[Step 3] Checking status after open...")
    st_res2 = service.get_device_status(settings)
    print("Success:", st_res2.is_success)
    print("Data:", st_res2.data)

    # 4. Close Fiscal Day (Z-Report)
    print("\n[Step 4] Closing Fiscal Day (Z-Report)...")
    close_res = service.close_fiscal_day(settings)
    print("Success:", close_res.is_success)
    print("Data:", close_res.data)
    print("Error:", close_res.error)
    assert close_res.is_success, f"Failed close day: {close_res.error}"

    # 5. Check Status after close
    print("\n[Step 5] Checking status after close...")
    st_res3 = service.get_device_status(settings)
    print("Success:", st_res3.is_success)
    print("Data:", st_res3.data)

    # 6. Test Auto-Open Day via Send Invoice
    print("\n[Step 6] Submitting a sale (verifies automatic day opening if closed)...")
    items_xml = (
        "<ITEMS>"
        "<ITEM>"
        "<CODE>001</CODE>"
        "<NAME>Sugar 2kg</NAME>"
        "<PRICE>2.50</PRICE>"
        "<QTY>2</QTY>"
        "<TAXID>1</TAXID>"
        "<TAX_PERCENT>15</TAX_PERCENT>"
        "<TAX_CODE>VAT</TAX_CODE>"
        "<HSCODE>17019900</HSCODE>"
        "<TOTAL>5.00</TOTAL>"
        "</ITEM>"
        "</ITEMS>"
    )
    inv_res = service.send_invoice(
        settings,
        invoice_number="INV-E2E-TEST-001",
        currency="USD",
        customer_name="Test Walk-in Customer",
        trade_name="Retail Buyer",
        items_xml=items_xml,
        tendered=5.00
    )
    print("Success:", inv_res.is_success)
    if inv_res.is_success:
        print("Fiscal Day:", inv_res.data.fiscal_day)
        print("Global No:", inv_res.data.receipt_global_no)
        print("QR Code:", inv_res.data.qr_code[:50] + "..." if inv_res.data.qr_code else "")
    else:
        print("Error:", inv_res.error)
    assert inv_res.is_success, f"Failed sale invoice: {inv_res.error}"

    print("\n==================================================")
    print("🎉 ALL HAVANO FISCAL DAY OPERATIONS VERIFIED 100%!")
    print("==================================================")

if __name__ == "__main__":
    main()
