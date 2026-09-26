package com.auliapos.wagateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * Test JVM murni (tanpa emulator) untuk [RuntimeDataPreserver] -- membuktikan
 * jalur simpan/kembalikan `auth/`/`data/` exception-safe (temuan CORR-01:
 * kegagalan I/O di tengah TIDAK boleh melempar keluar dan TIDAK boleh
 * menghapus satu-satunya salinan sesi WhatsApp / buffer retry).
 *
 * Operasi [RuntimeDataPreserver.Ops] disuntik untuk memaksa kegagalan
 * `copyRecursively` (mis. simulasi disk penuh) yang tidak bisa dipicu dengan
 * andal lewat berkas temp biasa.
 */
class RuntimeDataPreserverTest {

    @Rule
    @JvmField
    val temp = TemporaryFolder()

    private fun writeFile(dir: File, name: String, content: String) {
        val file = File(dir, name)
        file.parentFile?.mkdirs()
        file.writeText(content)
    }

    /** @return (projectDir, preservedRoot) dengan projectDir sudah ada. */
    private fun dirs(): Pair<File, File> {
        val base = temp.newFolder("app-files")
        val projectDir = File(base, "nodejs-project")
        val preservedRoot = File(base, "nodejs-project-preserved-tmp")
        projectDir.mkdirs()
        return projectDir to preservedRoot
    }

    private fun failingOps() = RuntimeDataPreserver.Ops(
        move = { _, _ -> false },
        copy = { _, _ -> throw IOException("disk penuh (simulasi)") },
    )

    @Test
    fun preserveThenRestoreKeepsRuntimeDataIntact() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(projectDir, "auth"), "creds.json", "sesi")
        writeFile(File(projectDir, "data"), "gateway.sqlite", "buffer")

        val saveFailures = RuntimeDataPreserver.preserve(projectDir, preservedRoot)
        assertTrue("preserve harus sukses: $saveFailures", saveFailures.isEmpty())
        assertFalse(File(projectDir, "auth").exists())
        assertTrue(File(preservedRoot, "auth/creds.json").exists())
        assertTrue(File(preservedRoot, "data/gateway.sqlite").exists())

        // Simulasikan salin ulang aset: projectDir dibuat ulang tanpa auth/data.
        projectDir.deleteRecursively()
        projectDir.mkdirs()

        val restoreFailures = RuntimeDataPreserver.restore(projectDir, preservedRoot)
        assertTrue("restore harus sukses: $restoreFailures", restoreFailures.isEmpty())
        assertEquals("sesi", File(projectDir, "auth/creds.json").readText())
        assertEquals("buffer", File(projectDir, "data/gateway.sqlite").readText())
        assertFalse("preservedRoot harus dibersihkan setelah sukses", preservedRoot.exists())
    }

    @Test
    fun copyFailureDuringRestoreDoesNotThrowAndKeepsPreservedCopy() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(preservedRoot, "auth"), "creds.json", "sesi-satunya-salinan")

        val failures = RuntimeDataPreserver.restore(projectDir, preservedRoot, failingOps())

        assertEquals(1, failures.size)
        assertEquals("auth", failures[0].name)
        assertTrue(
            "salinan di preservedRoot TIDAK boleh terhapus sebelum dipulihkan",
            File(preservedRoot, "auth/creds.json").exists(),
        )
        assertTrue("preservedRoot TIDAK boleh dihapus saat restore gagal", preservedRoot.exists())
        assertFalse("target tidak boleh tertinggal setengah jadi", File(projectDir, "auth").exists())
    }

    @Test
    fun copyFailureDuringRestoreRemovesPartialTargetSoItCannotOverwritePreservedCopy() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(preservedRoot, "auth"), "creds.json", "sesi-lengkap")

        // Simulasi copyRecursively yang sempat membuat target parsial lalu
        // gagal (mis. disk penuh) -- target parsial itu TIDAK boleh tersisa.
        val partialThenFail = RuntimeDataPreserver.Ops(
            move = { _, _ -> false },
            copy = { _, dst ->
                writeFile(dst, "partial.tmp", "setengah-jadi")
                throw IOException("disk penuh (simulasi)")
            },
        )

        val failures = RuntimeDataPreserver.restore(projectDir, preservedRoot, partialThenFail)

        assertEquals(1, failures.size)
        assertFalse("target parsial harus dibersihkan", File(projectDir, "auth").exists())
        assertTrue("salinan lengkap harus tetap ada", File(preservedRoot, "auth/creds.json").exists())
        assertEquals("sesi-lengkap", File(preservedRoot, "auth/creds.json").readText())
    }

    @Test
    fun copyFailureDuringPreserveDoesNotThrowAndKeepsSource() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(projectDir, "auth"), "creds.json", "sesi")

        val failures = RuntimeDataPreserver.preserve(projectDir, preservedRoot, failingOps())

        assertEquals(1, failures.size)
        assertEquals("auth", failures[0].name)
        assertEquals(
            "sumber harus tetap utuh saat simpan gagal (belum boleh dihapus)",
            "sesi",
            File(projectDir, "auth/creds.json").readText(),
        )
    }

    @Test
    fun firstInstallDoesNotLeaveStrayPreservedRoot() {
        val base = temp.newFolder("fresh")
        val projectDir = File(base, "nodejs-project")
        val preservedRoot = File(base, "nodejs-project-preserved-tmp")

        val saveFailures = RuntimeDataPreserver.preserve(projectDir, preservedRoot)
        assertTrue(saveFailures.isEmpty())
        assertFalse("install pertama tidak boleh membuat preserved-tmp nyangkut", preservedRoot.exists())

        val restoreFailures = RuntimeDataPreserver.restore(projectDir, preservedRoot)
        assertTrue(restoreFailures.isEmpty())
        assertFalse(preservedRoot.exists())
    }

    @Test
    fun reconcileRestoresPreservedCopyWhenProjectCopyMissing() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(preservedRoot, "auth"), "creds.json", "sesi")

        val failures = RuntimeDataPreserver.reconcile(projectDir, preservedRoot)

        assertTrue("reconcile harus sukses: $failures", failures.isEmpty())
        assertEquals("sesi", File(projectDir, "auth/creds.json").readText())
        assertFalse(preservedRoot.exists())
    }

    @Test
    fun reconcileKeepsPreservedRootWhenRestoreFails() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(preservedRoot, "auth"), "creds.json", "sesi")

        val failures = RuntimeDataPreserver.reconcile(projectDir, preservedRoot, failingOps())

        assertEquals(1, failures.size)
        assertTrue("salinan terakhir harus tetap ada saat rekonsiliasi gagal", File(preservedRoot, "auth/creds.json").exists())
        assertTrue(preservedRoot.exists())
    }

    @Test
    fun reconcileKeepsPreservedRootWhenTargetStillExists() {
        val (projectDir, preservedRoot) = dirs()
        writeFile(File(preservedRoot, "auth"), "creds.json", "lengkap")
        writeFile(File(projectDir, "auth"), "creds.json", "mungkin-parsial")

        val failures = RuntimeDataPreserver.reconcile(projectDir, preservedRoot)

        assertTrue(failures.isEmpty())
        assertTrue(
            "salinan di preservedRoot dipertahankan saat target masih ada (mungkin parsial)",
            File(preservedRoot, "auth/creds.json").exists(),
        )
        assertTrue(preservedRoot.exists())
    }
}
