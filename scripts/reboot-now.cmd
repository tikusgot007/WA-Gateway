@echo off
rem Reboot terkendali PC gateway (untuk menguji bootstrap + watchdog).
rem Pakai jeda 10 detik supaya masih bisa dibatalkan dengan `shutdown /a`.
shutdown /r /t 10 /f /c "uji reboot terjadwal (watchdog stack)"
